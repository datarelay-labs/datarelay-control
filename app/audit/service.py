"""Audit log recording and metadata sanitization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.audit.repository import insert_audit_log
from app.security.secrets import mask_secrets_and_pem

_VALID_RESULTS = frozenset({"success", "failure"})


@dataclass(frozen=True)
class AuditActor:
    actor_user_id: int | None = None
    actor_username: str | None = None
    ip_address: str | None = None
    user_agent: str | None = None


def sanitize_audit_metadata(value: Any) -> Any:
    """Remove plaintext secrets from audit metadata before persistence."""

    return mask_secrets_and_pem(value)


def build_audit_summary(
    *,
    action: str,
    entity_type: str | None,
    entity_id: int | None,
    result: str,
    metadata: dict[str, Any],
) -> str:
    parts: list[str] = [action]
    if entity_type:
        ent = entity_type
        if entity_id is not None:
            ent = f"{ent}#{entity_id}"
        parts.append(ent)
    name = metadata.get("entity_name")
    if isinstance(name, str) and name.strip():
        parts.append(f'"{name.strip()}"')
    if result != "success":
        parts.append(f"({result})")
    return " ".join(parts)


def audit_actor_from_request(request: Request | None, *, fallback_username: str = "system") -> AuditActor:
    if request is None:
        return AuditActor(actor_username=fallback_username)
    ctx = getattr(request.state, "auth", None)
    username = fallback_username
    user_id: int | None = None
    if ctx is not None:
        raw_name = getattr(ctx, "username", None)
        if raw_name:
            username = str(raw_name)
        uid = getattr(ctx, "user_id", None)
        if uid is not None:
            user_id = int(uid)
    client = request.client
    ip = str(client.host) if client and client.host else None
    ua = request.headers.get("user-agent")
    if ua:
        ua = str(ua)[:512]
    return AuditActor(
        actor_user_id=user_id,
        actor_username=username,
        ip_address=ip,
        user_agent=ua,
    )


def record_audit_log(
    db: Session,
    *,
    action: str,
    result: str = "success",
    actor_user_id: int | None = None,
    actor_username: str | None = None,
    entity_type: str | None = None,
    entity_id: int | None = None,
    metadata: dict[str, Any] | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    request: Request | None = None,
) -> AuditLog:
    """Persist a sanitized audit row (does not commit)."""

    res = (result or "success").strip().lower()
    if res not in _VALID_RESULTS:
        res = "success"

    if request is not None:
        actor = audit_actor_from_request(request, fallback_username=actor_username or "system")
        auth_ctx = getattr(request.state, "auth", None)
        authenticated = bool(auth_ctx is not None and getattr(auth_ctx, "username", None))
        if authenticated:
            # Authenticated HTTP caller is the canonical actor.
            actor_username = actor.actor_username
            if actor_user_id is None:
                actor_user_id = actor.actor_user_id
        else:
            actor_user_id = actor_user_id if actor_user_id is not None else actor.actor_user_id
            actor_username = actor_username if actor_username is not None else actor.actor_username
        ip_address = ip_address if ip_address is not None else actor.ip_address
        user_agent = user_agent if user_agent is not None else actor.user_agent

    meta_raw = dict(metadata or {})
    meta = sanitize_audit_metadata(meta_raw)
    if not isinstance(meta, dict):
        meta = {}

    row = AuditLog(
        actor_user_id=actor_user_id,
        actor_username=(actor_username or "system")[:128] if actor_username else "system",
        action=str(action)[:64],
        entity_type=str(entity_type)[:64] if entity_type else None,
        entity_id=int(entity_id) if entity_id is not None else None,
        result=res,
        ip_address=str(ip_address)[:64] if ip_address else None,
        user_agent=str(user_agent)[:512] if user_agent else None,
        metadata_json=meta,
    )
    return insert_audit_log(db, row)


def audit_log_to_read(row: AuditLog) -> dict[str, Any]:
    meta = dict(row.metadata_json or {})
    return {
        "id": int(row.id),
        "created_at": row.created_at,
        "actor_user_id": row.actor_user_id,
        "actor_username": row.actor_username,
        "action": row.action,
        "entity_type": row.entity_type,
        "entity_id": row.entity_id,
        "result": row.result,
        "ip_address": row.ip_address,
        "user_agent": row.user_agent,
        "metadata_json": meta,
        "summary": build_audit_summary(
            action=str(row.action),
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            result=str(row.result),
            metadata=meta,
        ),
    }
