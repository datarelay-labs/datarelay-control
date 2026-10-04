from __future__ import annotations

import os
import socket
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "e2e" / "user-lifecycle" / "run-user-lifecycle-e2e.sh"
DEFAULTS = ROOT / "e2e" / "user-lifecycle" / "config" / "defaults.env"
REQUIREMENTS = ROOT / "requirements.txt"
API_HELPER = ROOT / "e2e" / "user-lifecycle" / "helpers" / "api.ts"
USER_LIFECYCLE_MAIN = ROOT / "e2e" / "user-lifecycle" / "cli" / "main.ts"
GOVERNANCE_LIFECYCLE = ROOT / "e2e" / "user-lifecycle" / "helpers" / "governance-lifecycle.ts"


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


def test_runner_uses_requirements_hash_keyed_isolated_python_runtime() -> None:
    script = RUNNER.read_text(encoding="utf-8")
    requirements = REQUIREMENTS.read_text(encoding="utf-8")

    assert "jsonata-python>=0.6.0,<1" in requirements
    assert "ensure_python_runtime()" in script
    assert "sha256sum \"$ROOT/requirements.txt\"" in script
    assert "tr -c 'A-Za-z0-9._-' '_'" in script
    assert '${python_tag}-${requirements_hash:0:16}-${runtime_key}' in script
    ensure_start = script.index("ensure_python_runtime()")
    stop_scheduler = script.index('terminate_tracked_process_group "$GDC_E2E_PID_DIR/lab-scheduler.pid" "$ROOT"', ensure_start)
    stop_api = script.index('terminate_tracked_process_group "$GDC_E2E_PID_DIR/api.pid" "$ROOT"', ensure_start)
    replace_runtime = script.index('rm -rf "$runtime_dir" "$tmp_dir"', ensure_start)
    assert ensure_start < stop_scheduler < stop_api < replace_runtime
    assert '"$system_python" -m venv "$tmp_dir"' in script
    assert '"$tmp_dir/bin/python" -m pip install' in script
    assert 'python_runtime_${RUN_ID}.freeze.txt' in script
    assert '.requirements-sha256' in script
    assert "import fastapi, jsonata, psycopg2, sqlalchemy" in script
    assert 'export VIRTUAL_ENV="$runtime_dir"' in script
    assert 'export GDC_E2E_PYTHON_RUNTIME="$runtime_dir"' in script
    assert 'export GDC_E2E_PYTHON_RUNTIME_OWNED="$runtime_dir"' in script
    assert "cleanup_python_runtime()" in script
    assert "grep -qx 'CLEANUP=PASS'" in script
    assert 'PYTHON_RUNTIME_PRESERVED=$GDC_E2E_PYTHON_RUNTIME_OWNED REASON=cleanup-not-proven' in script



def test_cleanup_only_does_not_require_fresh_dependency_resolution() -> None:
    script = RUNNER.read_text(encoding="utf-8")

    helper_start = script.index("ensure_cleanup_python_runtime()")
    helper_end = script.index("\nensure_fixtures()", helper_start)
    cleanup_helper = script[helper_start:helper_end]
    assert "pip install" not in cleanup_helper
    assert "surviving owned API" in cleanup_helper
    surviving = cleanup_helper.index('tracked_process_matches "$GDC_E2E_PID_DIR/api.pid"')
    surviving_activate = cleanup_helper.index('export VIRTUAL_ENV="$runtime_dir"', surviving)
    surviving_path = cleanup_helper.index('export PATH="$runtime_dir/bin:$PATH"', surviving)
    surviving_return = cleanup_helper.index('RESOLUTION=surviving-api-reuse-existing', surviving)
    assert surviving < surviving_activate < surviving_path < surviving_return
    assert "reuse-existing" in cleanup_helper
    assert "local-existing" in cleanup_helper
    startup = script.index('if [[ "$MODE" == "cleanup" ]]; then')
    cleanup_call = script.index("ensure_cleanup_python_runtime", startup)
    normal_call = script.index("ensure_python_runtime", cleanup_call)
    assert startup < cleanup_call < normal_call
    service_cleanup_start = script.index("cleanup_owned_services()")
    runtime_cleanup_start = script.index("cleanup_python_runtime()")
    service_cleanup = script[service_cleanup_start:runtime_cleanup_start]
    assert 'rm -rf -- "$GDC_E2E_PYTHON_RUNTIME_OWNED"' not in service_cleanup
    assert 'rm -rf -- "$GDC_E2E_PYTHON_RUNTIME_OWNED"' in script[runtime_cleanup_start:]


def test_dynamic_wiremock_stubs_use_persisted_stream_http_method() -> None:
    helper = API_HELPER.read_text(encoding="utf-8")
    main = USER_LIFECYCLE_MAIN.read_text(encoding="utf-8")

    assert "method: string" in helper
    assert "const method = opts.method.trim().toUpperCase()" in helper
    assert "WireMock stub method is required" in helper
    assert "async function persistedStreamHttpMethod" in main
    assert "config.method ?? config.http_method" in main
    assert "method: primaryHttpMethod!" in main
    assert "method: streamMethod" in main
    assert "method: checkpointHttpMethod" in main


def test_governance_release_restores_stream_after_exception() -> None:
    helper = GOVERNANCE_LIFECYCLE.read_text(encoding="utf-8")

    assert "let releaseRestoreRequired = false" in helper
    original_readback = helper.index("const streamBeforeStop =")
    restore_armed = helper.index("releaseRestoreRequired = true")
    stop_request = helper.index("const stopResponse = await api.stopStream(streamId)")
    stopped_readback = helper.index("const stopped =")
    assert original_readback < restore_armed < stop_request < stopped_readback
    assert "} finally {" in helper
    assert "BFS015_QUARANTINE_RELEASE_RESTORE" in helper
    assert "await api.startStream(streamId).catch(() => null)" in helper


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
