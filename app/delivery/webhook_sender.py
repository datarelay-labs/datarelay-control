"""Webhook POST delivery."""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx

from app.http.outbound_httpx_timeout import outbound_httpx_timeout
from app.delivery.webhook_payload_mode import (
    WEBHOOK_PAYLOAD_MODE_BATCH,
    WEBHOOK_PAYLOAD_MODE_SINGLE,
    resolve_webhook_payload_mode,
)
from app.formatters.config_resolver import resolve_formatter_config
from app.formatters.json_formatter import format_webhook_events
from app.formatters.message_prefix import (
    MessagePrefixResolveContext,
    compact_event_json,
    effective_message_prefix_enabled,
    effective_message_prefix_template,
    resolve_message_prefix_template,
)
from app.runtime.errors import DestinationSendError

_httpx_pool_lock = threading.Lock()
_httpx_pool: dict[str, httpx.Client] = {}


def _borrow_httpx_client(*, pool_key: str, timeout: httpx.Timeout) -> httpx.Client:
    with _httpx_pool_lock:
        client = _httpx_pool.get(pool_key)
        if (
            client is None
            or getattr(client, "is_closed", False)
            or not isinstance(client, httpx.Client)
        ):
            client = httpx.Client(timeout=timeout)
            _httpx_pool[pool_key] = client
        return client


def _invalidate_httpx_client(pool_key: str) -> None:
    with _httpx_pool_lock:
        client = _httpx_pool.pop(pool_key, None)
    if client is not None and not getattr(client, "is_closed", False):
        client.close()


class WebhookSender:
    """Post event batches to webhook destinations with retry/backoff."""

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        *,
        prefix_context: MessagePrefixResolveContext | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        """Send events to webhook endpoint.

        Config supports: url, headers, timeout_seconds, retry_count, retry_backoff_seconds, batch_size.
        formatter_override: Route-level formatter when non-empty (same resolution as syslog).
        idempotency_key: optional Idempotency-Key header for sinks that support dedupe.
        """

        # StreamRunner skips calling send when extract_events returns []; keep guard for callers/tests.
        if not events:
            return

        try:
            resolve_formatter_config(config, formatter_override)
        except ValueError as exc:
            raise DestinationSendError(str(exc)) from exc

        url = str(config.get("url", "")).strip()
        if not url:
            raise DestinationSendError("Webhook destination requires url")

        headers = dict(config.get("headers", {}))
        if idempotency_key:
            headers = {**headers, "Idempotency-Key": str(idempotency_key)}
        timeout_seconds = float(config.get("timeout_seconds", 10))
        retries = int(config.get("retry_count", 2))
        backoff = float(config.get("retry_backoff_seconds", 1.0))
        batch_size = max(1, int(config.get("batch_size", len(events) or 1)))
        payload_mode = resolve_webhook_payload_mode(config)

        route_fc = dict(formatter_override or {})
        prefix_on = effective_message_prefix_enabled(route_fc, "WEBHOOK_POST")
        prefix_template = effective_message_prefix_template(route_fc)

        if prefix_on:
            batches = [
                events[i : i + batch_size] for i in range(0, len(events), batch_size)
            ]
        elif payload_mode == WEBHOOK_PAYLOAD_MODE_SINGLE:
            batches = [[e] for e in events]
        else:
            batches = [
                events[i : i + batch_size] for i in range(0, len(events), batch_size)
            ]

        httpx_timeout = outbound_httpx_timeout(timeout_seconds)
        pool_key = f"webhook:{url}"
        client = _borrow_httpx_client(pool_key=pool_key, timeout=httpx_timeout)
        try:
            for batch in batches:
                if prefix_on:
                    text = "\n".join(
                        f"{resolve_message_prefix_template(prefix_template, event=event, context=prefix_context).rstrip()} "
                        f"{compact_event_json(event)}"
                        for event in batch
                    )
                    post_headers = {**headers, "Content-Type": "text/plain; charset=utf-8"}
                    post_kwargs: dict = {"headers": post_headers, "content": text.encode("utf-8")}
                elif payload_mode == WEBHOOK_PAYLOAD_MODE_SINGLE:
                    assert len(batch) == 1
                    post_kwargs = {"headers": headers, "json": dict(batch[0])}
                else:
                    post_kwargs = {"headers": headers, "json": format_webhook_events(batch)}
                attempts = retries + 1

                for attempt in range(1, attempts + 1):
                    try:
                        response = client.post(url, **post_kwargs)
                        response.raise_for_status()
                        break
                    except httpx.HTTPStatusError as exc:
                        status = int(exc.response.status_code) if exc.response is not None else None
                        if attempt >= attempts:
                            _invalidate_httpx_client(pool_key)
                            raise DestinationSendError(
                                f"Webhook send failed after retries: {exc}",
                                http_status=status,
                            ) from exc
                        time.sleep(max(backoff * (2 ** (attempt - 1)), 0))
                    except httpx.HTTPError as exc:
                        if attempt >= attempts:
                            _invalidate_httpx_client(pool_key)
                            raise DestinationSendError(
                                f"Webhook send failed after retries: {exc}"
                            ) from exc
                        time.sleep(max(backoff * (2 ** (attempt - 1)), 0))
        except DestinationSendError:
            raise
        except httpx.HTTPError as exc:
            _invalidate_httpx_client(pool_key)
            raise DestinationSendError(f"Webhook send failed: {exc}") from exc
