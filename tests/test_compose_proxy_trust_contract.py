"""Contract: production/offline Compose never trusts wildcard proxy peers.

The API validator (app.auth.trusted_proxy) rejects '*' when proxy trust is
enabled, so a Compose file that hardcodes it cannot start. The Compose files
must instead require an explicit, restricted reverse-proxy IP/CIDR and fail
closed when it is missing.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.auth.trusted_proxy import trusted_proxy_peer_networks

ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILES = ["deploy/docker-compose.https.yml", "deploy/docker-compose.offline.yml"]
_ENTRY = re.compile(r"^\s*GDC_PROXY_FORWARD_TRUSTED_HOSTS:\s*(.+?)\s*$", re.MULTILINE)
_VAR = "GDC_PROXY_FORWARD_TRUSTED_HOSTS"


@pytest.mark.parametrize("rel", COMPOSE_FILES)
def test_compose_requires_explicit_trusted_proxy_peer(rel: str) -> None:
    text = (ROOT / rel).read_text(encoding="utf-8")
    entries = _ENTRY.findall(text)
    assert len(entries) == 1
    value = entries[0].strip("\"'")
    assert value.startswith("${" + _VAR + ":?") and value.endswith("}")
    assert "*" not in value
    assert "0.0.0.0/0" not in value


@pytest.mark.parametrize("rel", COMPOSE_FILES)
def test_compose_keeps_proxy_trust_enabled_for_forwarded_origin(rel: str) -> None:
    text = (ROOT / rel).read_text(encoding="utf-8")
    assert re.search(r'^\s*GDC_TRUST_PROXY_HEADERS:\s*"true"\s*$', text, re.MULTILINE)


def test_api_validator_rejects_wildcard_and_accepts_explicit_cidr() -> None:
    with pytest.raises(ValueError):
        trusted_proxy_peer_networks("*")
    with pytest.raises(ValueError):
        trusted_proxy_peer_networks("")
    assert trusted_proxy_peer_networks("192.0.2.200/32")


def test_ci_compose_validation_supplies_a_restricted_test_peer() -> None:
    text = (ROOT / ".github/workflows/docker-validate.yml").read_text(encoding="utf-8")
    match = re.search(r"^\s*" + _VAR + r":\s*(\S+)\s*$", text, re.MULTILINE)
    assert match is not None
    assert "*" not in match.group(1)
    trusted_proxy_peer_networks(match.group(1))


def test_env_example_does_not_suggest_wildcard_proxy_peers() -> None:
    text = (ROOT / ".env.example").read_text(encoding="utf-8")
    assert not re.search(r"^\s*#?\s*" + _VAR + r"=\s*\*", text, re.MULTILINE)
