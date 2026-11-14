"""Log redaction for outbound HTTP client loggers.

``httpx`` logs every request at INFO as ``HTTP Request: GET <full url>`` and the standalone scheduler enables
INFO logging, so a credential carried in the query string (``?api_key=...``) would be written to the log in
clear on every poll. The filter below masks secret-named query parameter values in those records.
"""

from __future__ import annotations

import logging

from app.security.secrets import mask_secret_query_params_in_text

_HTTP_CLIENT_LOGGERS = ("httpx", "httpcore")


class QuerySecretLogFilter(logging.Filter):
    """Mask secret-named ``name=value`` pairs (query-string credentials) in log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - never let redaction break logging
            return True
        masked = mask_secret_query_params_in_text(message)
        if masked != message:
            record.msg = masked
            record.args = ()
        return True


def install_http_client_log_redaction() -> None:
    """Attach :class:`QuerySecretLogFilter` to the httpx/httpcore loggers (idempotent)."""

    for name in _HTTP_CLIENT_LOGGERS:
        target = logging.getLogger(name)
        if not any(isinstance(f, QuerySecretLogFilter) for f in target.filters):
            target.addFilter(QuerySecretLogFilter())
