from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_reverse_proxy_healthcheck_accepts_http_or_https_mode() -> None:
    expected = "wget -qO- http://127.0.0.1/health >/dev/null || wget --no-check-certificate -qO- https://127.0.0.1/health >/dev/null"
    for rel in ("docker-compose.platform.yml", "deploy/docker-compose.https.yml"):
        text = (ROOT / rel).read_text(encoding="utf-8")
        assert expected in text
        assert 'test: ["CMD-SHELL"' in text
