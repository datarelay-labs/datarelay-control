"""Optimistic concurrency helpers shared by mutable configuration PUT handlers.

Mirrors the Route ``expected_updated_at`` / ``*_STALE_WRITE`` contract from P0.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def require_fresh_updated_at(
    *,
    entity_label: str,
    error_code: str,
    current_updated_at: datetime | None,
    expected_updated_at: datetime,
) -> None:
    """Raise 409 when the client's concurrency token does not match the locked row."""

    if current_updated_at is None or as_utc(current_updated_at) != as_utc(expected_updated_at):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": error_code,
                "message": (
                    f"{entity_label} changed since you started editing. Refresh the latest "
                    f"{entity_label.lower()} before saving again; unsaved local edits are not applied."
                ),
                "expected_updated_at": expected_updated_at.isoformat(),
                "current_updated_at": (
                    current_updated_at.isoformat() if current_updated_at is not None else None
                ),
            },
        )


def pop_expected_updated_at(update: dict[str, Any]) -> datetime:
    """Remove and return ``expected_updated_at`` from a model_dump payload."""

    value = update.pop("expected_updated_at", None)
    if value is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error_code": "EXPECTED_UPDATED_AT_REQUIRED",
                "message": "expected_updated_at is required for configuration updates",
            },
        )
    return value
