from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "release" / "_release_postgres_catalog.sh"


def _run_bash(body: str) -> subprocess.CompletedProcess[str]:
    script = f"""
set -u
source {shlex.quote(str(HELPER))}
{body}
"""
    return subprocess.run(
        ["bash", "-c", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_catalog_probe_uses_tcp_psql_against_target_catalog(tmp_path: Path) -> None:
    calls = tmp_path / "docker-calls.log"
    result = _run_bash(
        f"""
docker() {{
  printf '%s\\n' "$*" >> {shlex.quote(str(calls))}
  return 0
}}
gdc_release_postgres_catalog_usable \\
  {shlex.quote(str(ROOT))} docker-compose.platform.yml gdc gdc
"""
    )
    assert result.returncode == 0, result.stderr
    call = calls.read_text(encoding="utf-8")
    assert "compose -f docker-compose.platform.yml exec -T postgres sh -ec" in call
    assert "psql -h 127.0.0.1" in call
    assert 'PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"' in call
    assert "SELECT 1" in call


def test_catalog_wait_retries_until_final_server_is_usable(tmp_path: Path) -> None:
    counter = tmp_path / "counter"
    counter.write_text("0", encoding="utf-8")
    result = _run_bash(
        f"""
docker() {{
  n="$(cat {shlex.quote(str(counter))})"
  n=$((n + 1))
  printf '%s' "$n" > {shlex.quote(str(counter))}
  [[ "$n" -ge 3 ]]
}}
sleep() {{ :; }}
gdc_release_wait_for_postgres_catalog \\
  {shlex.quote(str(ROOT))} docker-compose.platform.yml gdc gdc 5 0
"""
    )
    assert result.returncode == 0, result.stderr
    assert counter.read_text(encoding="utf-8") == "3"


def test_catalog_wait_fails_closed_after_attempt_budget(tmp_path: Path) -> None:
    counter = tmp_path / "counter"
    counter.write_text("0", encoding="utf-8")
    result = _run_bash(
        f"""
docker() {{
  n="$(cat {shlex.quote(str(counter))})"
  n=$((n + 1))
  printf '%s' "$n" > {shlex.quote(str(counter))}
  return 1
}}
sleep() {{ :; }}
if gdc_release_wait_for_postgres_catalog \\
  {shlex.quote(str(ROOT))} docker-compose.platform.yml gdc gdc 3 0; then
  exit 19
fi
"""
    )
    assert result.returncode == 0, result.stderr
    assert counter.read_text(encoding="utf-8") == "3"


def test_install_uses_catalog_usability_wait_not_socket_pg_isready_loop() -> None:
    text = (ROOT / "scripts" / "release" / "install.sh").read_text(encoding="utf-8")
    assert "gdc_release_wait_for_postgres_catalog" in text
    assert 'exec -T postgres pg_isready -U "$_pg_user" -d "$_pg_db"' not in text
