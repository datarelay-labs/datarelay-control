"""Webhook receiver runtime service.

Inbound HTTP concerns stay here; the actual event pipeline remains StreamRunner:
source adapter -> extraction -> mapping -> enrichment -> route fan-out -> delivery.
"""

from __future__ import annotations

import hmac
import json
import logging
from dataclasses import dataclass
from typing import Any, Mapping

from sqlalchemy.orm import Session

from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.sources.adapters.webhook_receiver import WEBHOOK_PAYLOAD_CONFIG_KEY
from app.sources.models import Source
from app.streams.models import Stream

logger = logging.getLogger(__name__)

DEFAULT_MAX_REQUEST_BYTES = 1_048_576
DEFAULT_SHARED_SECRET_HEADER = "X-GDC-Webhook-Secret"
WEBHOOK_SOURCE_TYPES = {"WEBHOOK_RECEIVER", "WEBHOOK", "WEBHOOK_PUSH"}


class WebhookReceiverError(Exception):
    status_code = 400
    error_code = "WEBHOOK_RECEIVER_ERROR"


class WebhookReceiverNotFound(WebhookReceiverError):
    status_code = 404
    error_code = "WEBHOOK_RECEIVER_NOT_FOUND"


class WebhookReceiverDisabled(WebhookReceiverError):
    status_code = 409
    error_code = "WEBHOOK_RECEIVER_DISABLED"


class WebhookAuthFailed(WebhookReceiverError):
    status_code = 401
    error_code = "WEBHOOK_AUTH_FAILED"


class WebhookPayloadTooLarge(WebhookReceiverError):
    status_code = 413
    error_code = "WEBHOOK_PAYLOAD_TOO_LARGE"


class WebhookInvalidPayload(WebhookReceiverError):
    status_code = 400
    error_code = "WEBHOOK_INVALID_PAYLOAD"


@dataclass(frozen=True)
class ResolvedWebhookReceiver:
    source: Source
    stream: Stream


def _norm_receiver_key(value: str) -> str:
    return str(value or "").strip()


def _norm_auth_mode(value: Any) -> str:
    mode = str(value or "no_auth").strip().lower().replace("-", "_")
    aliases = {
        "none": "no_auth",
        "off": "no_auth",
        "shared_secret": "shared_secret_header",
        "secret": "shared_secret_header",
        "header": "shared_secret_header",
        "bearer": "bearer_token",
        "token": "bearer_token",
    }
    return aliases.get(mode, mode)


def _header_get(headers: Mapping[str, str], name: str) -> str:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return str(value)
    return ""


def _extract_bearer(headers: Mapping[str, str]) -> str:
    raw = _header_get(headers, "Authorization")
    prefix = "bearer "
    if raw.lower().startswith(prefix):
        return raw[len(prefix) :].strip()
    return ""


def _parse_ndjson(body: bytes) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line_no, raw_line in enumerate(body.decode("utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise WebhookInvalidPayload(f"Invalid NDJSON at line {line_no}: {exc.msg}") from exc
        if not isinstance(value, dict):
            raise WebhookInvalidPayload(f"NDJSON line {line_no} must be a JSON object")
        events.append(value)
    return events


def parse_webhook_payload(body: bytes, content_type: str | None) -> Any:
    """Parse JSON object, JSON array, or NDJSON webhook request bodies."""

    ctype = str(content_type or "").split(";", maxsplit=1)[0].strip().lower()
    if not body.strip():
        raise WebhookInvalidPayload("Webhook payload body is empty")

    if ctype in {"application/x-ndjson", "application/jsonl", "text/x-jsonl"}:
        return _parse_ndjson(body)

    try:
        value = json.loads(body)
    except json.JSONDecodeError as json_exc:
        if ctype in {"text/plain", "application/octet-stream", ""} and b"\n" in body:
            return _parse_ndjson(body)
        raise WebhookInvalidPayload(f"Invalid JSON payload: {json_exc.msg}") from json_exc

    if isinstance(value, dict | list):
        return value
    raise WebhookInvalidPayload("Webhook payload must be a JSON object, JSON array, or NDJSON stream")


class WebhookReceiver:
    """Validate inbound webhooks and feed the standard StreamRunner pipeline."""

    def __init__(self, *, runner: StreamRunner | None = None) -> None:
        self.runner = runner or StreamRunner()

    def dispatch(
        self,
        db: Session,
        *,
        receiver_key: str,
        headers: Mapping[str, str],
        body: bytes,
        content_type: str | None,
    ) -> dict[str, Any]:
        resolved = self._resolve(db, receiver_key)
        self._validate_enabled(resolved)
        max_bytes = self._max_request_bytes(resolved.source)
        if len(body) > max_bytes:
            self._log_ingest_failure(
                "webhook_payload_too_large",
                resolved=resolved,
                error_code=WebhookPayloadTooLarge.error_code,
                message=f"Webhook payload exceeds {max_bytes} bytes",
            )
            raise WebhookPayloadTooLarge(f"Webhook payload exceeds {max_bytes} bytes")
        self._authenticate(resolved, headers)
        try:
            payload = parse_webhook_payload(body, content_type)
        except WebhookInvalidPayload as exc:
            self._log_ingest_failure(
                "webhook_invalid_payload",
                resolved=resolved,
                error_code=WebhookInvalidPayload.error_code,
                message=str(exc),
            )
            raise

        context = load_stream_context(db, int(resolved.stream.id), require_enabled_stream=True)
        context.persist_checkpoint = False
        context.checkpoint = {"type": "WEBHOOK_PUSH", "value": {}}
        source_config = dict(context.stream.get("source_config") or {})
        source_config[WEBHOOK_PAYLOAD_CONFIG_KEY] = payload
        source_config["webhook_content_type"] = content_type or ""
        context.stream["source_config"] = source_config
        context.stream["source_type"] = "WEBHOOK_RECEIVER"

        summary = self.runner.run(context, db=db)
        summary["receiver_key"] = _norm_receiver_key(receiver_key)
        summary["checkpoint_updated"] = False
        return summary

    def _resolve(self, db: Session, receiver_key: str) -> ResolvedWebhookReceiver:
        key = _norm_receiver_key(receiver_key)
        if not key:
            raise WebhookReceiverNotFound("receiver_key is required")
        source = (
            db.query(Source)
            .filter(Source.source_type.in_(sorted(WEBHOOK_SOURCE_TYPES)))
            .filter(Source.config_json["receiver_key"].as_string() == key)
            .order_by(Source.id.asc())
            .first()
        )
        if source is None:
            self._log_ingest_failure(
                "webhook_receiver_not_found",
                receiver_key=key,
                error_code=WebhookReceiverNotFound.error_code,
                message="Webhook receiver not found",
            )
            raise WebhookReceiverNotFound("Webhook receiver not found")

        configured_stream_id = (source.config_json or {}).get("stream_id")
        query = db.query(Stream).filter(Stream.source_id == int(source.id)).order_by(Stream.id.asc())
        if configured_stream_id is not None:
            query = query.filter(Stream.id == int(configured_stream_id))
        stream = query.first()
        if stream is None:
            self._log_ingest_failure(
                "webhook_stream_not_found",
                source=source,
                error_code="WEBHOOK_STREAM_NOT_FOUND",
                message="Webhook receiver has no stream",
            )
            raise WebhookReceiverNotFound("Webhook receiver stream not found")
        return ResolvedWebhookReceiver(source=source, stream=stream)

    def _validate_enabled(self, resolved: ResolvedWebhookReceiver) -> None:
        if not bool(resolved.source.enabled):
            self._log_ingest_failure(
                "webhook_source_disabled",
                resolved=resolved,
                error_code=WebhookReceiverDisabled.error_code,
                message="Webhook receiver source is disabled",
            )
            raise WebhookReceiverDisabled("Webhook receiver source is disabled")
        if not bool(resolved.stream.enabled):
            self._log_ingest_failure(
                "webhook_stream_disabled",
                resolved=resolved,
                error_code=WebhookReceiverDisabled.error_code,
                message="Webhook receiver stream is disabled",
            )
            raise WebhookReceiverDisabled("Webhook receiver stream is disabled")

    def _authenticate(self, resolved: ResolvedWebhookReceiver, headers: Mapping[str, str]) -> None:
        cfg = resolved.source.config_json or {}
        auth = resolved.source.auth_json or {}
        mode = _norm_auth_mode(auth.get("auth_mode") or cfg.get("auth_mode") or cfg.get("webhook_auth_mode"))
        if mode == "no_auth":
            return
        if mode == "shared_secret_header":
            header_name = str(
                auth.get("header_name")
                or cfg.get("shared_secret_header_name")
                or cfg.get("auth_header_name")
                or DEFAULT_SHARED_SECRET_HEADER
            ).strip()
            expected = str(auth.get("shared_secret") or cfg.get("shared_secret") or "")
            actual = _header_get(headers, header_name)
            if expected and hmac.compare_digest(actual, expected):
                return
        elif mode == "bearer_token":
            expected = str(auth.get("bearer_token") or cfg.get("bearer_token") or cfg.get("token") or "")
            actual = _extract_bearer(headers)
            if expected and hmac.compare_digest(actual, expected):
                return
        else:
            self._log_ingest_failure(
                "webhook_auth_mode_invalid",
                resolved=resolved,
                error_code="WEBHOOK_AUTH_MODE_INVALID",
                message=f"Unsupported webhook auth mode: {mode}",
            )
            raise WebhookAuthFailed("Unsupported webhook auth mode")

        self._log_ingest_failure(
            "webhook_auth_failed",
            resolved=resolved,
            error_code=WebhookAuthFailed.error_code,
            message="Webhook authentication failed",
        )
        raise WebhookAuthFailed("Webhook authentication failed")

    def max_request_bytes_for_key(self, db: Session, receiver_key: str) -> int:
        """Look up configured max body size without consuming the request body.

        Returns ``DEFAULT_MAX_REQUEST_BYTES`` when the receiver is unknown so the
        HTTP layer can still refuse oversized bodies before ``request.body()``.
        """

        key = _norm_receiver_key(receiver_key)
        if not key:
            return DEFAULT_MAX_REQUEST_BYTES
        source = (
            db.query(Source)
            .filter(Source.source_type.in_(sorted(WEBHOOK_SOURCE_TYPES)))
            .filter(Source.config_json["receiver_key"].as_string() == key)
            .order_by(Source.id.asc())
            .first()
        )
        if source is None:
            return DEFAULT_MAX_REQUEST_BYTES
        return self._max_request_bytes(source)

    def _max_request_bytes(self, source: Source) -> int:
        raw = (source.config_json or {}).get("max_request_bytes", DEFAULT_MAX_REQUEST_BYTES)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return DEFAULT_MAX_REQUEST_BYTES
        return max(1024, min(value, 10 * 1024 * 1024))

    def _log_ingest_failure(
        self,
        stage: str,
        *,
        resolved: ResolvedWebhookReceiver | None = None,
        source: Source | None = None,
        receiver_key: str | None = None,
        error_code: str,
        message: str,
    ) -> None:
        src = source or (resolved.source if resolved is not None else None)
        stream = resolved.stream if resolved is not None else None
        logger.warning(
            "%s",
            {
                "stage": stage,
                "receiver_key": receiver_key or ((src.config_json or {}).get("receiver_key") if src is not None else None),
                "connector_id": int(src.connector_id) if src is not None else None,
                "source_id": int(src.id) if src is not None else None,
                "stream_id": int(stream.id) if stream is not None else None,
                "error_code": error_code,
                "message": message,
            },
        )
