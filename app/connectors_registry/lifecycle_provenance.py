"""Additive marketplace provenance on materialized Stream config (no runtime semantics change)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.streams.models import Stream

PROVENANCE_CONFIG_KEY = "marketplace_provenance"


def provenance_payload(*, package_id: str, pack_version: str) -> dict[str, str]:
    return {
        "package_id": package_id,
        "pack_version": pack_version,
    }


def attach_provenance(
    config_json: dict[str, Any] | None,
    *,
    package_id: str,
    pack_version: str,
) -> dict[str, Any]:
    """Return config_json with additive marketplace provenance (non-authoritative for runtime)."""

    payload = dict(config_json or {})
    payload[PROVENANCE_CONFIG_KEY] = provenance_payload(
        package_id=package_id,
        pack_version=pack_version,
    )
    return payload


def streams_depending_on_package(db: Session, package_id: str) -> list[Stream]:
    """Return streams whose config_json records materialization from ``package_id``."""

    rows = db.query(Stream).all()
    matches: list[Stream] = []
    for row in rows:
        cfg = dict(row.config_json or {})
        provenance = cfg.get(PROVENANCE_CONFIG_KEY)
        if not isinstance(provenance, dict):
            continue
        if str(provenance.get("package_id") or "").strip() == package_id:
            matches.append(row)
    return matches
