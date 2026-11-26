"""Name-collision detection shared by import preview and apply (E-124).

Connectors and destinations are identified by display name in the operator UI, so an import that silently
creates a second entity with an existing name leaves the operator unable to tell them apart. Preview reports
every collision; apply refuses to proceed without an explicit choice (``skip`` or ``rename``) and never
creates a same-name duplicate.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.destinations.models import Destination

NAME_MAX_LENGTH = 255
NAME_CONFLICT_CHOICES: tuple[str, ...] = ("skip", "rename")


def normalize_name(name: Any) -> str:
    return str(name or "").strip()


def import_connector_name(row: dict[str, Any], suffix: str) -> str:
    """Final display name of an imported connector (clone mode appends ``suffix``)."""

    return str(row.get("name") or "imported-connector") + suffix


def import_destination_name(row: dict[str, Any], export_id: int) -> str:
    return str(row.get("name") or f"imported-destination-{export_id}")


def existing_name_index(db: Session, model: Any) -> dict[str, list[int]]:
    """Normalized display name -> ids of the existing rows (ascending)."""

    index: dict[str, list[int]] = defaultdict(list)
    for row_id, name in db.query(model.id, model.name).order_by(model.id.asc()).all():
        index[normalize_name(name)].append(int(row_id))
    return index


def unique_name(base: str, taken: set[str]) -> str:
    """``base`` with the first free `` (n)`` suffix (n >= 2) that is not in ``taken`` (normalized names)."""

    n = 2
    while True:
        tail = f" ({n})"
        candidate = base[: NAME_MAX_LENGTH - len(tail)] + tail
        if normalize_name(candidate) not in taken:
            return candidate
        n += 1


def _message(entity: str, name: str, existing_ids: list[int]) -> str:
    ids = ", ".join(str(i) for i in existing_ids[:5]) + ("..." if len(existing_ids) > 5 else "")
    return (
        f"A {entity} named {name!r} already exists (id {ids}). Applying this import requires an explicit "
        "choice: skip it, or create it under a new unique name."
    )


def find_name_conflicts(db: Session, bundle: dict[str, Any], *, mode: str, suffix: str) -> list[dict[str, Any]]:
    """Connectors and destinations of ``bundle`` whose final name already exists in this database."""

    out: list[dict[str, Any]] = []
    connectors = [c for c in (bundle.get("connectors") or []) if isinstance(c, dict) and c.get("id") is not None]
    destinations = [d for d in (bundle.get("destinations") or []) if isinstance(d, dict) and d.get("id") is not None]
    if connectors:
        index = existing_name_index(db, Connector)
        for c in connectors:
            name = import_connector_name(c, suffix if mode == "clone" else "")
            ids = index.get(normalize_name(name))
            if ids:
                out.append(
                    {
                        "entity_type": "connector",
                        "name": name,
                        "export_id": int(c["id"]),
                        "existing_ids": list(ids),
                        "message": _message("connector", name, ids),
                    }
                )
    if destinations:
        dest_index = existing_name_index(db, Destination)
        for d in destinations:
            name = import_destination_name(d, int(d["id"]))
            ids = dest_index.get(normalize_name(name))
            if ids:
                out.append(
                    {
                        "entity_type": "destination",
                        "name": name,
                        "export_id": int(d["id"]),
                        "existing_ids": list(ids),
                        "message": _message("destination", name, ids),
                    }
                )
    return out
