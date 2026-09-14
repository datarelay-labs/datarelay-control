from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = ROOT / "docker" / "reverse-proxy" / "default.conf.bootstrap"
ENTRYPOINT = ROOT / "docker" / "reverse-proxy" / "entrypoint.sh"
COMPOSE = ROOT / "docker-compose.platform.yml"


def test_reverse_proxy_bootstrap_is_http_only_until_https_is_enabled() -> None:
    text = BOOTSTRAP.read_text(encoding="utf-8")

    assert "listen 80 default_server;" in text
    assert "listen 443 ssl" not in text
    assert "ssl_certificate" not in text
    assert text.count("location /health") == 1
    assert text.count("location /api/") == 1
    assert text.count("proxy_pass $gdc_ui_upstream;") >= 2


def test_reverse_proxy_entrypoint_generates_cert_only_for_rendered_https_config() -> None:
    text = ENTRYPOINT.read_text(encoding="utf-8")

    assert "openssl req -x509" in text
    assert "TLS_CERT=\"/var/gdc/tls/server.crt\"" in text
    assert "TLS_KEY=\"/var/gdc/tls/server.key\"" in text
    assert "listen[[:space:]]+443[[:space:]]+ssl" in text
    assert "HTTPS is controlled by the rendered nginx config" in text


def test_platform_compose_keeps_configurable_external_ports_and_writable_tls_volume() -> None:
    text = COMPOSE.read_text(encoding="utf-8")

    assert '"${GDC_PROXY_BIND:-127.0.0.1}:${GDC_HTTP_PORT:-18080}:80"' in text
    assert '"${GDC_PROXY_BIND:-127.0.0.1}:${GDC_HTTPS_PORT:-18443}:443"' in text
    assert "gdc_platform_tls:/var/gdc/tls:ro" not in text
    assert "gdc_platform_tls:/var/gdc/tls" in text
