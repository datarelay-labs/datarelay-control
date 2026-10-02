from __future__ import annotations

import os
import socket
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "e2e" / "user-lifecycle" / "run-user-lifecycle-e2e.sh"
DEFAULTS = ROOT / "e2e" / "user-lifecycle" / "config" / "defaults.env"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_defaults_preserve_caller_environment_overrides() -> None:
    env = os.environ.copy()
    env.update(
        {
            "GDC_E2E_API_PORT": "28121",
            "GDC_E2E_UI_PORT": "24195",
            "GDC_E2E_PID_DIR": "/tmp/custom-ulc-pids",
            "REQUIRE_AUTH": "true",
        }
    )
    result = subprocess.run(
        [
            "bash",
            "-c",
            f'source "{DEFAULTS}"; printf "%s|%s|%s|%s" "$GDC_E2E_API_PORT" "$GDC_E2E_UI_PORT" "$GDC_E2E_PID_DIR" "$REQUIRE_AUTH"',
        ],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=5,
    )
    assert result.returncode == 0
    assert result.stdout == "28121|24195|/tmp/custom-ulc-pids|true"


def test_runner_uses_owned_process_contract_and_current_schema() -> None:
    script = RUNNER.read_text(encoding="utf-8")
    assert "tracked_process_matches()" in script
    assert "terminate_tracked_process_group()" in script
    assert 'require_free_untracked_port "API"' in script
    assert 'require_free_untracked_port "UI"' in script
    assert "fuser -k" not in script
    assert "nohup setsid python3 -m uvicorn" in script
    assert "nohup setsid python3 -m app.scheduler.standalone" in script
    assert "nohup setsid npx --yes vite preview" in script
    assert "--strictPort" in script
    assert "alembic upgrade head" in script
    assert "alembic upgrade 20260804_0062" not in script
    assert "npm ci" in script
    assert "frontend_npm_ci_" in script


def test_runner_fails_closed_on_unowned_api_port(tmp_path: Path) -> None:
    pid_dir = tmp_path / "pids"
    log_dir = tmp_path / "logs"
    artifact_dir = tmp_path / "artifacts"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        api_port = int(listener.getsockname()[1])
        env = os.environ.copy()
        env.update(
            {
                "GDC_E2E_API_PORT": str(api_port),
                "GDC_E2E_UI_PORT": str(_free_port()),
                "GDC_E2E_PID_DIR": str(pid_dir),
                "GDC_E2E_LOG_DIR": str(log_dir),
                "ULC_ARTIFACT_DIR": str(artifact_dir),
            }
        )
        result = subprocess.run(
            [str(RUNNER), "--scenario", "00_SMOKE_BROWSER", "--run-id", "pytest-port-guard"],
            cwd=ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=10,
        )
        assert listener.getsockname()[1] == api_port

    assert result.returncode != 0
    assert f"API port 127.0.0.1:{api_port} is already in use" in result.stdout
    assert "Refusing to reuse or terminate an unowned listener" in result.stdout
    assert "WARN: missing fixture container" not in result.stdout


def test_runner_fails_closed_on_unowned_ui_port(tmp_path: Path) -> None:
    pid_dir = tmp_path / "pids"
    log_dir = tmp_path / "logs"
    artifact_dir = tmp_path / "artifacts"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        ui_port = int(listener.getsockname()[1])
        env = os.environ.copy()
        env.update(
            {
                "GDC_E2E_API_PORT": str(_free_port()),
                "GDC_E2E_UI_PORT": str(ui_port),
                "GDC_E2E_PID_DIR": str(pid_dir),
                "GDC_E2E_LOG_DIR": str(log_dir),
                "ULC_ARTIFACT_DIR": str(artifact_dir),
            }
        )
        result = subprocess.run(
            [str(RUNNER), "--scenario", "00_SMOKE_BROWSER", "--run-id", "pytest-ui-port-guard"],
            cwd=ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=10,
        )
        assert listener.getsockname()[1] == ui_port

    assert result.returncode != 0
    assert f"UI port 127.0.0.1:{ui_port} is already in use" in result.stdout
    assert "Refusing to reuse or terminate an unowned listener" in result.stdout
    assert "WARN: missing fixture container" not in result.stdout
