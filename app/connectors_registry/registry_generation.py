"""DB-backed connector registry generation for cross-process cache invalidation."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TypeVar

from sqlalchemy.orm import Session

from app.connectors_registry.registry_version_models import (
    REGISTRY_VERSION_SINGLETON_ID,
    ConnectorRegistryVersion,
)
from app.database import SessionLocal, utcnow

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], Session]
T = TypeVar("T")


def ensure_registry_version_row(db: Session) -> ConnectorRegistryVersion:
    """Return the singleton generation row, inserting generation=0 when missing."""

    row = (
        db.query(ConnectorRegistryVersion)
        .filter(ConnectorRegistryVersion.id == REGISTRY_VERSION_SINGLETON_ID)
        .first()
    )
    if row is not None:
        return row
    row = ConnectorRegistryVersion(
        id=REGISTRY_VERSION_SINGLETON_ID,
        generation=0,
        updated_at=utcnow(),
    )
    db.add(row)
    db.flush()
    return row


def read_registry_generation(db: Session) -> int:
    """Return current registry generation, bootstrapping the singleton when needed."""

    return int(ensure_registry_version_row(db).generation)


def bump_registry_generation(db: Session) -> int:
    """Increment registry generation inside the caller's transaction. Returns new value."""

    row = (
        db.query(ConnectorRegistryVersion)
        .filter(ConnectorRegistryVersion.id == REGISTRY_VERSION_SINGLETON_ID)
        .with_for_update()
        .first()
    )
    if row is None:
        row = ConnectorRegistryVersion(
            id=REGISTRY_VERSION_SINGLETON_ID,
            generation=0,
            updated_at=utcnow(),
        )
        db.add(row)
        db.flush()
        row = (
            db.query(ConnectorRegistryVersion)
            .filter(ConnectorRegistryVersion.id == REGISTRY_VERSION_SINGLETON_ID)
            .with_for_update()
            .one()
        )
    row.generation = int(row.generation) + 1
    row.updated_at = utcnow()
    db.flush()
    return int(row.generation)


def fetch_registry_generation(*, session_factory: SessionFactory | None = None) -> int:
    """Open a short-lived session and return the current generation (bootstraps if needed)."""

    factory = session_factory or SessionLocal
    db = factory()
    try:
        value = read_registry_generation(db)
        db.commit()
        return value
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
