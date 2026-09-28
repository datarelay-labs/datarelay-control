"""Regression coverage for canonical test-stack fixture ownership."""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STARTER = ROOT / "scripts" / "testing" / "start-test-stack.sh"


def _bash(body: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", f"source {shlex.quote(str(STARTER))}\n{body}"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=10,
    )


def test_healthy_occupied_fixture_is_reused_without_compose_plan() -> None:
    result = _bash(
        r"""
FIXTURE_SERVICES=()
host_tcp_open() { return 0; }
expected_ready() { return 0; }
plan_fixture "fixture" fixture-service 12345 expected_ready
printf 'COUNT=%s\n' "${#FIXTURE_SERVICES[@]}"
"""
    )

    assert result.returncode == 0, result.stdout
    assert "reusing canonical fixture" in result.stdout
    assert "COUNT=0" in result.stdout


def test_incompatible_occupied_fixture_fails_closed() -> None:
    result = _bash(
        r"""
FIXTURE_SERVICES=()
host_tcp_open() { return 0; }
expected_ready() { return 1; }
set +e
plan_fixture "fixture" fixture-service 12345 expected_ready
rc=$?
set -e
printf 'RC=%s COUNT=%s\n' "$rc" "${#FIXTURE_SERVICES[@]}"
"""
    )

    assert result.returncode == 0, result.stdout
    assert "occupied but does not satisfy" in result.stdout
    assert "RC=1 COUNT=0" in result.stdout


def test_free_fixture_port_is_scheduled_for_compose_start() -> None:
    result = _bash(
        r"""
FIXTURE_SERVICES=()
host_tcp_open() { return 1; }
expected_ready() { return 1; }
plan_fixture "fixture" fixture-service 12345 expected_ready
printf 'COUNT=%s SERVICE=%s\n' "${#FIXTURE_SERVICES[@]}" "${FIXTURE_SERVICES[0]}"
"""
    )

    assert result.returncode == 0, result.stdout
    assert "COUNT=1 SERVICE=fixture-service" in result.stdout


def test_partial_syslog_port_ownership_fails_closed() -> None:
    result = _bash(
        r"""
FIXTURE_SERVICES=()
host_tcp_open() {
  [[ "$2" == "$SYSLOG_PORT" ]]
}
set +e
plan_syslog_fixture
rc=$?
set -e
printf 'RC=%s COUNT=%s\n' "$rc" "${#FIXTURE_SERVICES[@]}"
"""
    )

    assert result.returncode == 0, result.stdout
    assert "partially occupied" in result.stdout
    assert "RC=1 COUNT=0" in result.stdout


def test_starter_has_no_unconditional_all_service_compose_up() -> None:
    script = STARTER.read_text(encoding="utf-8")
    assert 'FIXTURE_SERVICES=()' in script
    assert 'docker compose -p "$COMPOSE_PROJECT_NAME" -f "$GDC_TEST_COMPOSE_FILE" up -d "${FIXTURE_SERVICES[@]}"' in script
    assert "plan_fixture \"PostgreSQL smoke\"" in script
    assert "plan_fixture \"WireMock\"" in script
    assert "plan_fixture \"Webhook echo\"" in script
    assert "plan_syslog_fixture" in script
