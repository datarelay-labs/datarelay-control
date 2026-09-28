from __future__ import annotations

import os
import socket
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "e2e" / "run-full-e2e-lab.sh"
LAB_DIR = ROOT / "e2e" / "lab"
FAULT_SCRIPT = LAB_DIR / "fault-inject.sh"


def _runner() -> str:
    return RUNNER.read_text(encoding="utf-8")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _run_with_profile(*, api_port: int, ui_port: int) -> subprocess.CompletedProcess[str]:
    profile = f"pytest-isolation-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    env_file = LAB_DIR / f".env.{profile}-route-on"
    env_file.write_text(
        "\n".join(
            [
                "COMPOSE_PROFILES=e2e",
                f"COMPOSE_PROJECT_NAME=gdc-{profile}",
                f"GDC_TEST_CONTAINER_PREFIX=gdc-{profile}",
                "GDC_ROUTE_PROCESSING_ENABLED=true",
                f"GDC_E2E_API_PORT={api_port}",
                f"GDC_E2E_UI_PORT={ui_port}",
                f"GDC_E2E_PID_DIR=e2e/reports/.pids-{profile}",
                f"GDC_E2E_LOG_DIR=e2e/reports/lab-logs-{profile}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    try:
        return subprocess.run(
            [
                str(RUNNER),
                "up",
                "--route-processing=on",
                "--lab-profile",
                profile,
            ],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=15,
            check=False,
        )
    finally:
        env_file.unlink(missing_ok=True)


def test_api_reuse_is_bound_to_exact_git_head_and_unowned_port_fails_closed() -> None:
    script = _runner()
    assert 'local api_head_file="$PID_DIR/api-git-head.txt"' in script
    assert '"$api_have_head" == "$git_head"' in script
    assert 'tracked_process_matches "$PID_DIR/api.pid" "$ROOT"' in script
    assert 'require_free_untracked_port "API" "${GDC_E2E_API_PORT:-18000}" 0 || return 1' in script
    assert 'require_started_process "API" "$PID_DIR/api.pid"' in script
    assert 'require_free_untracked_port "API" "${GDC_E2E_API_PORT:-18000}" "$preflight_api_tracked" || return 1' in script


def test_ui_reuse_is_bound_to_exact_git_head_and_build_provenance() -> None:
    script = _runner()
    assert 'local ui_head_file="$PID_DIR/ui-git-head.txt"' in script
    assert 'local ui_build_head_file="$PID_DIR/ui-build-git-head.txt"' in script
    assert '"$ui_have_head" == "$git_head"' in script
    assert '"$ui_build_head" != "$git_head"' in script
    assert 'tracked_process_matches "$PID_DIR/ui.pid" "$ROOT/frontend"' in script
    assert 'require_free_untracked_port "UI" "${GDC_E2E_UI_PORT:-4173}" 0 || return 1' in script
    assert 'require_free_untracked_port "UI" "${GDC_E2E_UI_PORT:-4173}" "$preflight_ui_tracked" || return 1' in script
    assert "--strictPort" in script
    assert '|| echo "WARN: UI preview not ready' not in script


def test_harness_processes_use_owned_process_groups() -> None:
    script = _runner()
    assert "tracked_process_matches()" in script
    assert "terminate_tracked_process_group()" in script
    assert "nohup setsid python3 -m uvicorn" in script
    assert "nohup setsid python3 -m app.scheduler.standalone" in script
    assert "nohup setsid npx --yes vite preview" in script
    assert "fuser -k" not in script


def test_down_terminates_only_tracked_process_groups_from_this_worktree() -> None:
    script = _runner()
    down = script.split("cmd_down() {", 1)[1].split("\n}\n\ncmd_all()", 1)[0]
    assert 'terminate_tracked_process_group "$PID_DIR/api.pid" "$ROOT"' in down
    assert 'terminate_tracked_process_group "$PID_DIR/lab-scheduler.pid" "$ROOT"' in down
    assert 'terminate_tracked_process_group "$PID_DIR/ui.pid" "$ROOT/frontend"' in down


def test_signal_traps_do_not_skip_down_when_evidence_returns_nonzero() -> None:
    script = _runner()
    expected = (
        'post_run_evidence_and_cleanup "$ec" || true; '
        '[[ "${GDC_E2E_KEEP_UP:-0}" != "1" ]] && cmd_down; exit 130'
    )
    assert script.count(expected) == 2


def test_ui_build_failure_is_not_silently_ignored() -> None:
    script = _runner()
    assert 'if ! npm run build >"$LOG_DIR/ui_build_$RUN_ID.log" 2>&1; then' in script
    assert "frontend build failed; refusing to stamp current HEAD or launch stale dist" in script
    assert 'npm run build >"$LOG_DIR/ui_build_$RUN_ID.log" 2>&1 || true' not in script
    assert ') || return 1\n    require_started_process "UI"' in script
    assert 'wait_http "$WIREMOCK_BASE_URL/__admin/mappings" "WireMock" 60 || return 1' in script
    assert 'alembic upgrade head' in script
    assert 'ERROR: Alembic upgrade failed' in script


def test_up_fails_closed_before_compose_when_api_port_is_unowned() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        api_port = int(listener.getsockname()[1])
        result = _run_with_profile(api_port=api_port, ui_port=_free_port())

    assert result.returncode != 0
    assert f"API port 127.0.0.1:{api_port} is already in use" in result.stdout
    assert "docker compose" not in result.stdout


def test_up_fails_closed_before_compose_when_ui_port_is_unowned() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        ui_port = int(listener.getsockname()[1])
        result = _run_with_profile(api_port=_free_port(), ui_port=ui_port)

    assert result.returncode != 0
    assert f"UI port 127.0.0.1:{ui_port} is already in use" in result.stdout
    assert "docker compose" not in result.stdout


def test_command_wrappers_preserve_errexit_while_capturing_setup_status() -> None:
    script = _runner()
    assert "run_setup_step_preserving_errexit()" in script
    assert 'run_setup_step_preserving_errexit cmd_up' in script
    assert 'run_setup_step_preserving_errexit cmd_reset' in script
    assert 'cmd_up ||' not in script
    assert 'cmd_reset ||' not in script
    assert script.count('run_setup_step_preserving_errexit cmd_up') == 3
    assert script.count('run_setup_step_preserving_errexit cmd_reset') == 3


def test_setup_status_helper_reenables_errexit_inside_actual_helper_body() -> None:
    script = _runner()
    helper = (
        "SETUP_STEP_EC=0\n"
        + script.split("SETUP_STEP_EC=0\n", 1)[1].split("\n\ncmd_scenario() {", 1)[0]
    )
    probe = helper + r"""
failing_setup() {
  false
  echo SHOULD_NOT_RUN
}
run_setup_step_preserving_errexit failing_setup
echo "SETUP_STEP_EC=$SETUP_STEP_EC"
"""
    result = subprocess.run(
        ["bash", "-c", "set -e\n" + probe],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=5,
        check=False,
    )

    assert result.returncode == 0
    assert "SETUP_STEP_EC=1" in result.stdout
    assert "SHOULD_NOT_RUN" not in result.stdout


def test_fault_inject_uses_same_process_ownership_contract() -> None:
    script = FAULT_SCRIPT.read_text(encoding="utf-8")
    assert "tracked_process_matches()" in script
    assert "terminate_tracked_process_group()" in script
    assert "nohup setsid python3 -m uvicorn" in script
    assert "nohup setsid python3 -m app.scheduler.standalone" in script
    assert "fuser -k" not in script
    assert "lsof -t -iTCP" not in script
    assert 'GDC_E2E_TEARDOWN' in script
    assert "--connect-timeout 1 --max-time 2" in script


def test_fault_inject_refuses_to_kill_unowned_api_listener(tmp_path: Path) -> None:
    pid_dir = tmp_path / "pids"
    log_dir = tmp_path / "logs"
    state_dir = tmp_path / "state"
    pid_dir.mkdir()
    log_dir.mkdir()
    state_dir.mkdir()

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = int(listener.getsockname()[1])
        env = os.environ.copy()
        env.update(
            {
                "GDC_E2E_API_PORT": str(port),
                "GDC_E2E_PID_DIR": str(pid_dir),
                "GDC_E2E_LOG_DIR": str(log_dir),
                "GDC_E2E_FAULT_STATE_DIR": str(state_dir),
            }
        )
        result = subprocess.run(
            [str(FAULT_SCRIPT), "start", "api"],
            cwd=ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=10,
            check=False,
        )
        # The test process still owns the listening socket after the harness refusal.
        assert listener.getsockname()[1] == port

    assert result.returncode != 0
    assert "refusing cross-worktree kill" in result.stdout


def test_fault_reset_teardown_mode_never_restarts_api_or_fixtures(tmp_path: Path) -> None:
    pid_dir = tmp_path / "pids"
    log_dir = tmp_path / "logs"
    state_dir = tmp_path / "state"
    pid_dir.mkdir()
    log_dir.mkdir()
    state_dir.mkdir()
    (state_dir / "api.active").write_text("api\n", encoding="utf-8")

    env = os.environ.copy()
    env.update(
        {
            "GDC_E2E_TEARDOWN": "1",
            "GDC_E2E_PID_DIR": str(pid_dir),
            "GDC_E2E_LOG_DIR": str(log_dir),
            "GDC_E2E_FAULT_STATE_DIR": str(state_dir),
        }
    )
    result = subprocess.run(
        [str(FAULT_SCRIPT), "reset"],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=5,
        check=False,
    )

    assert result.returncode == 0
    assert "teardown mode" in result.stdout
    assert not (state_dir / "api.active").exists()
