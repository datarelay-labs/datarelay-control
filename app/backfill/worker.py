"""Backfill worker — operational replay via StreamRunner (checkpoint-safe)."""

from __future__ import annotations

import copy
from dataclasses import replace
from datetime import datetime

from sqlalchemy.orm import Session

from app.backfill.repository import get_backfill_job, save_job, stage_progress_event
from app.backfill.runtime import BackfillRuntimeCoordinator
from app.database import utcnow
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner


def _parse_iso_dt(raw: str) -> datetime:
    s = str(raw).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


class BackfillWorker:
    """Runs operator replay in-process; commits short transactions for job metadata."""

    def __init__(self, db: Session, coordinator: BackfillRuntimeCoordinator) -> None:
        self._db = db
        self._coord = coordinator

    def request_cancel(self, job_id: int) -> None:
        self._coord.request_cancel(int(job_id))

    def emit_event(
        self,
        *,
        backfill_job_id: int,
        stream_id: int,
        event_type: str,
        level: str,
        message: str,
        progress_json: dict | None = None,
        error_code: str | None = None,
    ) -> None:
        stage_progress_event(
            self._db,
            backfill_job_id=int(backfill_job_id),
            stream_id=int(stream_id),
            event_type=str(event_type),
            level=str(level),
            message=str(message),
            progress_json=progress_json,
            error_code=error_code,
        )
        self._db.commit()

    def start_job(self, job_id: int) -> None:
        """Delegates to replay execution when a time window is present."""

        if not self._coord.claim_job_owner(int(job_id)):
            return
        try:
            job = get_backfill_job(self._db, int(job_id))
            if job is None:
                return
            opts = job.runtime_options_json or {}
            if opts.get("start_time") and opts.get("end_time"):
                self.run_replay_job(int(job_id))
            else:
                self.run_dry_lifecycle(int(job_id))
        finally:
            self._coord.release_job_owner(int(job_id))

    def run_replay_job(self, job_id: int) -> None:
        """Fetch → map → enrich → routes → destinations via StreamRunner; never advances production checkpoint."""

        job = get_backfill_job(self._db, int(job_id))
        if job is None or job.status not in ("RUNNING", "CANCELLING"):
            return
        if self._coord.is_cancel_requested(int(job_id)) or job.status == "CANCELLING":
            self._cancel_terminal(job_id, int(job.stream_id))
            return

        opts = job.runtime_options_json or {}
        try:
            start_dt = _parse_iso_dt(str(opts["start_time"]))
            end_dt = _parse_iso_dt(str(opts["end_time"]))
        except (KeyError, TypeError, ValueError) as exc:
            self._fail_job(job_id, job.stream_id, f"invalid backfill window: {exc}")
            return

        if start_dt >= end_dt:
            self._fail_job(job_id, job.stream_id, "start_time must be before end_time")
            return

        dry_run = bool(opts.get("dry_run"))
        stream_id = int(job.stream_id)
        self.emit_event(
            backfill_job_id=int(job_id),
            stream_id=stream_id,
            event_type="replay_started",
            level="INFO",
            message="Operational replay started (StreamRunner)",
            progress_json={"dry_run": dry_run},
        )

        try:
            base = load_stream_context(self._db, stream_id, require_enabled_stream=False)
        except ValueError as exc:
            self._fail_job(job_id, stream_id, str(exc))
            return

        ctx = replace(
            base,
            persist_checkpoint=False,
            replay_start=start_dt,
            replay_end=end_dt,
            dry_run=dry_run,
        )

        runner = StreamRunner()
        try:
            summary = runner.run(ctx, db=self._db)
        except Exception as exc:  # pragma: no cover - surfaced to job row
            self._fail_job(job_id, stream_id, str(exc))
            return

        if self._coord.is_cancel_requested(int(job_id)):
            self._cancel_terminal(job_id, stream_id)
            return

        job2 = get_backfill_job(self._db, int(job_id))
        if job2 is None:
            return
        if job2.status == "CANCELLING" or self._coord.is_cancel_requested(int(job_id)):
            self._cancel_terminal(job_id, stream_id)
            return
        if job2.status != "RUNNING":
            return

        outcome = str(summary.get("outcome") or "")
        ex = int(summary.get("extracted_event_count") or 0)
        sent = int(summary.get("delivered_batch_event_count") or 0)
        skipped = int(summary.get("skipped_delivery_count") or 0)
        failed = max(0, ex - sent - skipped)

        merged = copy.deepcopy(job2.progress_json or {})
        merged.update(
            {
                "phase": "completed",
                "stream_outcome": outcome,
                "extracted_event_count": ex,
                "delivered_batch_event_count": sent,
            }
        )
        job2.progress_json = merged
        job2.delivery_summary_json = {
            "status": outcome,
            "sent": sent,
            "failed": failed,
            "skipped": skipped,
        }
        if outcome == "skipped_lock":
            job2.status = "FAILED"
            job2.failed_at = utcnow()
            job2.error_summary = "Stream lock held; replay did not run"
        else:
            job2.status = "COMPLETED"
            job2.completed_at = utcnow()
            job2.error_summary = None
        save_job(self._db, job2)
        self.emit_event(
            backfill_job_id=int(job_id),
            stream_id=stream_id,
            event_type="replay_completed",
            level="INFO",
            message="Operational replay completed",
            progress_json=job2.delivery_summary_json,
        )

    def _fail_job(self, job_id: int, stream_id: int, message: str) -> None:
        job = get_backfill_job(self._db, int(job_id))
        if job is None:
            return
        if job.status not in ("RUNNING", "CANCELLING"):
            return
        job.status = "FAILED"
        job.failed_at = utcnow()
        job.error_summary = message[:8000]
        save_job(self._db, job)
        self.emit_event(
            backfill_job_id=int(job_id),
            stream_id=int(stream_id),
            event_type="job_failed",
            level="ERROR",
            message=message[:512],
            error_code="REPLAY_FAILED",
        )

    def _cancel_terminal(self, job_id: int, stream_id: int) -> None:
        """Worker ack: RUNNING/CANCELLING → CANCELLED."""

        job = get_backfill_job(self._db, int(job_id))
        if job is None:
            return
        if job.status not in ("RUNNING", "CANCELLING"):
            return
        job.status = "CANCELLED"
        if job.completed_at is None:
            job.completed_at = utcnow()
        save_job(self._db, job)
        self.emit_event(
            backfill_job_id=int(job_id),
            stream_id=int(stream_id),
            event_type="job_cancelled",
            level="INFO",
            message="Replay cancelled before completion",
        )
        self._coord.clear_job_session(int(job_id))

    def run_dry_lifecycle(self, job_id: int) -> None:
        """Legacy no-op chunk markers when no replay window is configured."""

        job = get_backfill_job(self._db, int(job_id))
        if job is None or job.status not in ("RUNNING", "CANCELLING"):
            return
        if self._coord.is_cancel_requested(int(job_id)) or job.status == "CANCELLING":
            self._cancel_terminal(job_id, int(job.stream_id))
            return

        stream_id = int(job.stream_id)

        self.emit_event(
            backfill_job_id=int(job_id),
            stream_id=stream_id,
            event_type="chunk_started",
            level="INFO",
            message="Dry-run chunk started",
            progress_json={"chunk_index": 0},
        )

        self.emit_event(
            backfill_job_id=int(job_id),
            stream_id=stream_id,
            event_type="checkpoint_snapshot_used",
            level="INFO",
            message="Using immutable checkpoint snapshot captured at job creation",
            progress_json={"source": "checkpoint_snapshot_json"},
        )

        self.emit_event(
            backfill_job_id=int(job_id),
            stream_id=stream_id,
            event_type="chunk_completed",
            level="INFO",
            message="Dry-run chunk completed",
            progress_json={"chunk_index": 0},
        )

        job = get_backfill_job(self._db, int(job_id))
        if job is None:
            return
        if job.status == "CANCELLING" or self._coord.is_cancel_requested(int(job_id)):
            self._cancel_terminal(job_id, stream_id)
            return
        if job.status != "RUNNING":
            return

        merged = copy.deepcopy(job.progress_json or {})
        merged.update({"phase": "running", "chunk_index": 0, "chunks_done": 1})
        job.progress_json = merged

        opts = job.runtime_options_json or {}
        if bool(opts.get("dry_run_complete")):
            job.status = "COMPLETED"
            job.completed_at = utcnow()
            save_job(self._db, job)
            self.emit_event(
                backfill_job_id=int(job_id),
                stream_id=stream_id,
                event_type="job_completed",
                level="INFO",
                message="Dry-run completed",
                progress_json={"dry_run": True},
            )
        else:
            save_job(self._db, job)
