"""Backfill runtime coordinator — isolated from StreamRunner scheduling semantics."""

from __future__ import annotations

import copy
import threading
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint


CHECKPOINT_COMMIT_POLICY_EXPLICIT_ONLY = "EXPLICIT_ONLY"


class BackfillRuntimeCoordinator:
    """Owns ephemeral backfill state: snapshots, progress hooks, cancellation (Phase 1 skeleton).

    StreamRunner remains the sole transaction owner for normal runtime DB writes. This coordinator
    must not mutate ``checkpoints`` automatically; merge is a future explicit operation.
    """

    CHECKPOINT_COMMIT_POLICY: str = CHECKPOINT_COMMIT_POLICY_EXPLICIT_ONLY

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ephemeral_by_job: dict[int, dict[str, Any]] = {}
        self._cancel_requested: set[int] = set()
        # Process-local live worker ownership (not durable). Lost on restart → startup reconcile.
        self._owned_jobs: set[int] = set()

    @staticmethod
    def capture_checkpoint_snapshot(db: Session, stream_id: int) -> dict[str, Any] | None:
        """Read-only capture of the current stream checkpoint row (for ``checkpoint_snapshot_json``)."""

        row = db.scalars(select(Checkpoint).where(Checkpoint.stream_id == int(stream_id))).first()
        if row is None:
            return None
        return {
            "checkpoint_type": row.checkpoint_type,
            "checkpoint_value_json": copy.deepcopy(row.checkpoint_value_json),
            "captured_stream_id": int(stream_id),
        }

    @staticmethod
    def build_ephemeral_checkpoint_state(snapshot: dict[str, Any] | None) -> dict[str, Any]:
        """Seed isolated mutable checkpoint state from a snapshot (never writes DB)."""

        if snapshot is None:
            return {"mode": "empty", "checkpoint_type": "NONE", "checkpoint_value_json": {}}
        return {
            "mode": "from_snapshot",
            "checkpoint_type": snapshot.get("checkpoint_type"),
            "checkpoint_value_json": copy.deepcopy(snapshot.get("checkpoint_value_json") or {}),
        }

    def register_job_session(self, job_id: int, *, checkpoint_snapshot: dict[str, Any] | None) -> dict[str, Any]:
        """Attach ephemeral runtime state for a job (memory-only in Phase 1)."""

        state = {
            "ephemeral_checkpoint": self.build_ephemeral_checkpoint_state(checkpoint_snapshot),
            "chunks_done": 0,
        }
        with self._lock:
            self._ephemeral_by_job[int(job_id)] = state
        return state

    def get_ephemeral_state(self, job_id: int) -> dict[str, Any] | None:
        with self._lock:
            raw = self._ephemeral_by_job.get(int(job_id))
            return copy.deepcopy(raw) if raw is not None else None

    def clear_job_session(self, job_id: int) -> None:
        with self._lock:
            jid = int(job_id)
            self._ephemeral_by_job.pop(jid, None)
            self._cancel_requested.discard(jid)
            self._owned_jobs.discard(jid)

    def claim_job_owner(self, job_id: int) -> bool:
        """Mark this process as the live worker owner for ``job_id`` (exclusive)."""

        with self._lock:
            jid = int(job_id)
            if jid in self._owned_jobs:
                return False
            self._owned_jobs.add(jid)
            return True

    def release_job_owner(self, job_id: int) -> None:
        with self._lock:
            self._owned_jobs.discard(int(job_id))

    def is_job_owned(self, job_id: int) -> bool:
        with self._lock:
            return int(job_id) in self._owned_jobs

    def request_cancel(self, job_id: int) -> None:
        with self._lock:
            self._cancel_requested.add(int(job_id))

    def is_cancel_requested(self, job_id: int) -> bool:
        with self._lock:
            return int(job_id) in self._cancel_requested

    def reset_ephemeral_for_tests(self) -> None:
        """Test-only hook: clear in-memory coordinator state between cases."""

        with self._lock:
            self._ephemeral_by_job.clear()
            self._cancel_requested.clear()
            self._owned_jobs.clear()

    def iter_chunk_placeholders(self, job_id: int, *, total_chunks: int | None = None) -> list[dict[str, Any]]:
        """Placeholder chunk orchestration (no source IO). Future: drive per-source strategies."""

        if self.is_cancel_requested(job_id):
            return []
        return [{"job_id": int(job_id), "chunk_index": 0, "total_chunks": total_chunks}]
