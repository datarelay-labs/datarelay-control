"""E-096: outbound HTTP client logs must not carry query-string credentials."""

from __future__ import annotations

import logging

import httpx

from app.security.log_redaction import QuerySecretLogFilter, install_http_client_log_redaction


def test_httpx_request_log_masks_query_secret(caplog, monkeypatch) -> None:
    # Alembic's ``fileConfig`` (run by DB-backed fixtures earlier in the session) disables existing loggers.
    httpx_logger = logging.getLogger("httpx")
    monkeypatch.setattr(httpx_logger, "disabled", False)
    monkeypatch.setattr(httpx_logger, "propagate", True)
    install_http_client_log_redaction()
    install_http_client_log_redaction()  # idempotent
    assert sum(isinstance(f, QuerySecretLogFilter) for f in logging.getLogger("httpx").filters) == 1

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    with caplog.at_level(logging.INFO, logger="httpx"):
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            client.get("http://probe.test/events", params={"api_key": "LIVE-KEY-123456", "limit": "2"})

    text = "\n".join(r.getMessage() for r in caplog.records if r.name == "httpx")
    assert "HTTP Request" in text
    assert "LIVE-KEY-123456" not in text
    assert "limit=2" in text
    assert "api_key=********" in text


def test_filter_leaves_unrelated_records_untouched() -> None:
    record = logging.LogRecord("httpx", logging.INFO, __file__, 1, "plain %s", ("message",), None)
    assert QuerySecretLogFilter().filter(record) is True
    assert record.getMessage() == "plain message"
