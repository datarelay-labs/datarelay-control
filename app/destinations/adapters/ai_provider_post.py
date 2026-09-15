"""AI_PROVIDER_POST destination adapter."""

from __future__ import annotations

import time
from typing import Any

from app.ai_policy.runtime_integration import (
    enforce_prompt_before_provider,
    enforce_response_after_provider,
    resolve_ai_stream_id,
)
from app.ai_providers.adapters.registry import get_ai_provider_adapter_registry
from app.ai_providers.adapters.types import ProviderSendResult
from app.ai_providers.retry import should_retry_ai_provider_error
from app.destinations.adapters.base import DestinationAdapter
from app.formatters.message_prefix import MessagePrefixResolveContext
from app.runtime.errors import DestinationSendError
from app.runners.stream_runner_db import short_db_session


def _extract_provider_request(event: dict[str, Any]) -> dict[str, Any]:
    request = event.get("provider_request")
    if isinstance(request, dict) and request:
        return dict(request)
    ai_body = (event.get("ai") or {}).get("body") if isinstance(event.get("ai"), dict) else None
    if isinstance(ai_body, dict) and ai_body:
        return dict(ai_body)
    raise DestinationSendError("AI_PROVIDER_POST event missing provider_request")


class AiProviderPostDestinationAdapter(DestinationAdapter):
    @staticmethod
    def _capture_sync_response(
        destination_config: dict[str, Any],
        event: dict[str, Any],
        result: ProviderSendResult,
        *,
        provider_response: dict[str, Any] | None = None,
    ) -> None:
        holder = destination_config.get("_ai_sync_holder")
        if not isinstance(holder, dict):
            return
        if provider_response is not None:
            holder["provider_response"] = provider_response
            ai = event.get("ai") if isinstance(event.get("ai"), dict) else {}
            if isinstance(ai, dict) and ai.get("request_id"):
                holder["request_id"] = str(ai.get("request_id"))
            return
        normalized = dict(result.normalized_response or {})
        raw = normalized.get("raw")
        if isinstance(raw, dict):
            holder["provider_response"] = raw
        else:
            holder["provider_response"] = normalized
        ai = event.get("ai") if isinstance(event.get("ai"), dict) else {}
        if isinstance(ai, dict) and ai.get("request_id"):
            holder["request_id"] = str(ai.get("request_id"))

    @staticmethod
    def _enforce_prompt(
        *,
        policy_db: Any,
        use_short_policy_sessions: bool,
        ai_stream_id: int | None,
        provider_request: dict[str, Any],
        log_fn: Any,
        stream_id: int | None,
        audit_ctx: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if use_short_policy_sessions:
            with short_db_session(commit=True) as db:
                return enforce_prompt_before_provider(
                    db,
                    ai_stream_id=ai_stream_id,
                    provider_request=provider_request,
                    log_fn=log_fn,
                    stream_id=stream_id,
                    audit_ctx=audit_ctx,
                    commit_audit=True,
                )
        return enforce_prompt_before_provider(
            policy_db,
            ai_stream_id=ai_stream_id,
            provider_request=provider_request,
            log_fn=log_fn,
            stream_id=stream_id,
            audit_ctx=audit_ctx,
        )

    @staticmethod
    def _enforce_response(
        *,
        policy_db: Any,
        use_short_policy_sessions: bool,
        ai_stream_id: int | None,
        provider_response: dict[str, Any],
        log_fn: Any,
        stream_id: int | None,
        audit_ctx: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if use_short_policy_sessions:
            with short_db_session(commit=True) as db:
                return enforce_response_after_provider(
                    db,
                    ai_stream_id=ai_stream_id,
                    provider_response=provider_response,
                    log_fn=log_fn,
                    stream_id=stream_id,
                    audit_ctx=audit_ctx,
                    commit_audit=True,
                )
        return enforce_response_after_provider(
            policy_db,
            ai_stream_id=ai_stream_id,
            provider_response=provider_response,
            log_fn=log_fn,
            stream_id=stream_id,
            audit_ctx=audit_ctx,
        )

    def send(
        self,
        events: list[dict[str, Any]],
        destination_config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        *,
        prefix_context: MessagePrefixResolveContext | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        _ = formatter_override, prefix_context, idempotency_key
        if not events:
            return

        provider_bundle = dict((destination_config or {}).get("_provider") or {})
        if not provider_bundle:
            raise DestinationSendError("AI_PROVIDER_POST destination missing resolved provider config")

        policy_db = destination_config.get("_policy_db")
        use_short_policy_sessions = bool(destination_config.get("_policy_db_short_sessions"))
        stream_id_raw = destination_config.get("_stream_id")
        stream_id = int(stream_id_raw) if stream_id_raw is not None else None
        ai_stream_id_raw = destination_config.get("_ai_stream_id")
        ai_stream_id = int(ai_stream_id_raw) if ai_stream_id_raw is not None else None
        if ai_stream_id is None and stream_id is not None:
            if use_short_policy_sessions:
                with short_db_session(commit=False) as read_db:
                    ai_stream_id = resolve_ai_stream_id(read_db, stream_id=stream_id)
            elif policy_db is not None:
                ai_stream_id = resolve_ai_stream_id(policy_db, stream_id=stream_id)

        provider_type = str(provider_bundle.get("provider_type") or destination_config.get("provider_type") or "")
        auth_json = dict(provider_bundle.get("auth_json") or {})
        timeout_seconds = float(
            destination_config.get("timeout_seconds")
            or provider_bundle.get("timeout_seconds")
            or 120
        )
        retry_count = int(destination_config.get("retry_count", 1))
        retry_backoff = float(destination_config.get("retry_backoff_seconds", 2.0))
        attempts = max(1, retry_count + 1)

        adapter = get_ai_provider_adapter_registry().get(provider_type)
        provider_config = dict(provider_bundle)
        if destination_config.get("model_override"):
            provider_config["model_override"] = destination_config.get("model_override")

        log_fn = destination_config.get("_ai_policy_log_fn")

        sync_holder = destination_config.get("_ai_sync_holder")
        holder_request_id = ""
        if isinstance(sync_holder, dict) and sync_holder.get("request_id"):
            holder_request_id = str(sync_holder["request_id"])

        for event in events:
            provider_request = _extract_provider_request(event)
            ai_meta = event.get("ai") if isinstance(event.get("ai"), dict) else {}
            request_id = holder_request_id
            if not request_id and isinstance(ai_meta, dict) and ai_meta.get("request_id"):
                request_id = str(ai_meta["request_id"])
            model_name = provider_request.get("model") or provider_bundle.get("default_model")
            audit_ctx = {
                "request_id": request_id,
                "ai_provider_id": provider_bundle.get("provider_id"),
                "provider": provider_type,
                "model": str(model_name) if model_name else None,
            }
            provider_request = self._enforce_prompt(
                policy_db=policy_db,
                use_short_policy_sessions=use_short_policy_sessions,
                ai_stream_id=ai_stream_id,
                provider_request=provider_request,
                log_fn=log_fn if callable(log_fn) else None,
                stream_id=stream_id,
                audit_ctx=audit_ctx if request_id else None,
            )
            http_request = adapter.build_http_request(provider_request, provider_config, auth_json)
            last_error: Exception | None = None
            result: ProviderSendResult | None = None
            for attempt in range(1, attempts + 1):
                try:
                    result = adapter.send_request(http_request, timeout_seconds=timeout_seconds)
                    last_error = None
                    break
                except Exception as exc:
                    last_error = exc
                    if attempt >= attempts or not should_retry_ai_provider_error(exc):
                        break
                    time.sleep(max(retry_backoff * (2 ** (attempt - 1)), 0))
            if last_error is not None:
                if isinstance(last_error, DestinationSendError):
                    raise last_error
                status = getattr(last_error, "http_status", None)
                raise DestinationSendError(str(last_error), http_status=status) from last_error
            if result is None:
                raise DestinationSendError("AI provider send returned no result")
            normalized = dict(result.normalized_response or {})
            raw = normalized.get("raw")
            provider_response = raw if isinstance(raw, dict) else normalized
            provider_response = self._enforce_response(
                policy_db=policy_db,
                use_short_policy_sessions=use_short_policy_sessions,
                ai_stream_id=ai_stream_id,
                provider_response=dict(provider_response),
                log_fn=log_fn if callable(log_fn) else None,
                stream_id=stream_id,
                audit_ctx=audit_ctx if request_id else None,
            )
            self._capture_sync_response(
                destination_config,
                event,
                result,
                provider_response=provider_response,
            )
