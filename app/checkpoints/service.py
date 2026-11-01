"""Checkpoint use-cases — update only after successful delivery."""

from __future__ import annotations

from app.runtime.copy_utils import copy_event_dict, copy_json_value
from datetime import datetime, timezone
from threading import Lock
from typing import Any

from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.checkpoints.repository import get_checkpoint_by_stream_id, upsert_checkpoint
from app.checkpoints.route_delivery_state import (
    ROUTE_DELIVERY_STATE_KEY,
    checkpoint_anchor,
    split_route_delivery_state,
)


class CheckpointService:
    """In-memory checkpoint store with success-only update semantics.

    This skeleton intentionally avoids DB writes in this phase and provides a safe,
    testable checkpoint boundary for StreamRunner.
    """

    _store: dict[int, dict[str, Any]] = {}
    _lock = Lock()

    def get_checkpoint_for_stream(self, stream_id: int) -> dict[str, Any] | None:
        """Return a deep-copied checkpoint payload for a stream."""

        with self._lock:
            checkpoint = self._store.get(stream_id)
            return copy_json_value(checkpoint) if checkpoint is not None else None

    def update(self, stream_id: int, last_success_event: dict[str, Any] | None) -> dict[str, Any] | None:
        """Persist checkpoint using only the last successfully delivered event.

        If ``last_success_event`` is ``None``, no checkpoint is updated.
        """

        if last_success_event is None:
            return None

        payload = {
            "last_success_event": copy_event_dict(last_success_event),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._lock:
            self._store[stream_id] = payload
        return copy_json_value(payload)

    def update_after_successful_delivery(self, stream_id: int, last_success_event: dict[str, Any]) -> dict[str, Any]:
        """Backward-compatible alias for success-only checkpoint updates."""

        updated = self.update(stream_id, last_success_event)
        return updated or {}

    def get_checkpoint(self, db: Session, stream_id: int) -> dict[str, Any] | None:
        """Load checkpoint payload from DB."""

        row = get_checkpoint_by_stream_id(db, stream_id)
        if row is None:
            return None
        value = getattr(row, "checkpoint_value_json", None)
        return copy_json_value(value) if isinstance(value, dict) else None

    def update_checkpoint_after_success(
        self,
        db: Session,
        stream_id: int,
        checkpoint_type: str,
        checkpoint_value: dict[str, Any],
    ) -> dict[str, Any]:
        """Upsert checkpoint in DB after delivery success."""

        row = upsert_checkpoint(
            db=db,
            stream_id=stream_id,
            checkpoint_type=checkpoint_type,
            checkpoint_value_json=copy_json_value(checkpoint_value),
        )
        value = getattr(row, "checkpoint_value_json", None)
        return copy_json_value(value) if isinstance(value, dict) else {}

    def save_route_delivery_state(
        self,
        db: Session,
        stream_id: int,
        checkpoint_type: str,
        anchor: str,
        route_delivery_state: dict[str, Any] | None,
    ) -> bool:
        """Persist per-Route delivery fingerprints without advancing the checkpoint.

        Only the route delivery key changes; the cursor fields and ``updated_at`` (used by
        checkpoint-window dedup scope) stay untouched. Skips the write when the checkpoint
        window moved since the run loaded it (``anchor`` mismatch). Returns True on write.
        """

        row = get_checkpoint_by_stream_id(db, stream_id)
        current = getattr(row, "checkpoint_value_json", None) if row is not None else None
        current = current if isinstance(current, dict) else None
        base, _ = split_route_delivery_state(current)
        if checkpoint_anchor(base) != anchor:
            return False

        if row is None:
            if not route_delivery_state:
                return False
            upsert_checkpoint(
                db=db,
                stream_id=stream_id,
                checkpoint_type=checkpoint_type,
                checkpoint_value_json={ROUTE_DELIVERY_STATE_KEY: copy_json_value(route_delivery_state)},
            )
            return True

        new_value = {
            key: copy_json_value(value)
            for key, value in (current or {}).items()
            if key != ROUTE_DELIVERY_STATE_KEY
        }
        if route_delivery_state:
            new_value[ROUTE_DELIVERY_STATE_KEY] = copy_json_value(route_delivery_state)
        if new_value == (current or {}):
            return False
        # Explicit updated_at = updated_at suppresses the model onupdate timestamp.
        db.query(Checkpoint).filter(Checkpoint.id == row.id).update(
            {
                Checkpoint.checkpoint_value_json: new_value,
                Checkpoint.updated_at: Checkpoint.updated_at,
            },
            synchronize_session=False,
        )
        db.expire(row, ["checkpoint_value_json"])
        return True
