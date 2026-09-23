"""Periodic alert monitor that scans runtime state and fires platform alerts.

The monitor runs in its own daemon thread and is fully decoupled from
``StreamRunner``.  It reads delivery_logs / streams / checkpoints state in
read-only sessions and dispatches alerts via :func:`deliver_alert`.  Any
failures (HTTP, DB, parse) are swallowed so that monitoring never affects the
runtime pipeline.

Detected alert types
--------------------

* ``stream_paused`` — stream is currently disabled but was previously running.
* ``checkpoint_stalled`` — enabled stream with no checkpoint update within the
  stall threshold while runs have been attempted.
* ``destination_failed`` — at least one route on this stream has more failures
  than successes within the last hour (and >= ``_DEST_FAILED_MIN`` failures).
* ``high_retry_count`` — a route has more than ``_HIGH_RETRY_THRESHOLD`` retry
  outcomes within the last hour.
* ``rate_limit_triggered`` — recent delivery_logs include a rate-limit stage.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import SessionLocal
from app.logs.models import DeliveryLog
from app.platform_admin.alert_service import AlertEvent, deliver_alert
from app.platform_admin.repository import get_alert_settings_row
from app.routes.models import Route
from app.streams.models import Stream

logger = logging.getLogger(__name__)

UTC = timezone.utc

_DEFAULT_TICK_SECONDS = 60.0
_SHORT_SLEEP_SECONDS = 5.0
_RECENT_WINDOW = timedelta(hours=1)
_CHECKPOINT_STALL_THRESHOLD = timedelta(hours=2)
_DEST_FAILED_MIN = 3
_HIGH_RETRY_THRESHOLD = 10
_RATE_LIMIT_STAGE_KEYWORDS = ("rate_limit", "rate-limit")


class PlatformAlertMonitor:
    """Daemon thread that detects alert-worthy state transitions and dispatches alerts."""

    def __init__(self, *, tick_seconds: float | None = None) -> None:
        self._tick_seconds = float(tick_seconds or _DEFAULT_TICK_SECONDS)
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._started_at: datetime | None = None
        self._last_tick_at: datetime | None = None
        self._lock = threading.Lock()
        # Process-local memory of last-known stream enabled state so we only
        # alert on enabled→disabled transitions, never on a steady-state stop.
        self._last_stream_enabled: dict[int, bool] = {}

    @property
    def started_at(self) -> datetime | None:
        return self._started_at

    def is_running(self) -> bool:
        t = self._thread
        return t is not None and t.is_alive()

    def last_tick_at(self) -> datetime | None:
        return self._last_tick_at

    def start(self) -> None:
        if self.is_running():
            return
        self._stop_event.clear()
        self._started_at = datetime.now(UTC)
        thread = threading.Thread(target=self._loop, name="platform-alert-monitor", daemon=True)
        self._thread = thread
        thread.start()
        logger.info("%s", {"stage": "platform_alert_monitor_started"})

    def stop(self) -> None:
        self._stop_event.set()
        t = self._thread
        if t is not None:
            t.join(timeout=5.0)
        self._thread = None
        logger.info("%s", {"stage": "platform_alert_monitor_stopped"})

    def trigger_once(self) -> list[AlertEvent]:
        """Run one detection sweep synchronously and return dispatched events."""

        return self._sweep()

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._sweep()
            except Exception as exc:  # pragma: no cover - defensive
                logger.exception(
                    "%s",
                    {
                        "stage": "platform_alert_monitor_error",
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                    },
                )
            self._stop_event.wait(max(self._tick_seconds, _SHORT_SLEEP_SECONDS))

    def _sweep(self) -> list[AlertEvent]:
        with self._lock:
            self._last_tick_at = datetime.now(UTC)
            db = SessionLocal()
            try:
                settings_row = get_alert_settings_row(db)
                if not bool(settings_row.monitor_enabled):
                    return []
                events: list[AlertEvent] = []
                events += self._detect_stream_paused(db)
                events += self._detect_checkpoint_stalled(db)
                events += self._detect_destination_failed(db)
                events += self._detect_high_retry_count(db)
                events += self._detect_rate_limit_triggered(db)
                for ev in events:
                    deliver_alert(db, ev)
                return events
            finally:
                db.close()

    def _detect_stream_paused(self, db: Session) -> list[AlertEvent]:
        events: list[AlertEvent] = []
        streams = list(db.scalars(select(Stream)))
        seen_ids: set[int] = set()
        for s in streams:
            sid = int(s.id)
            seen_ids.add(sid)
            enabled = bool(s.enabled)
            was_enabled = self._last_stream_enabled.get(sid)
            if was_enabled is True and enabled is False:
                events.append(
                    AlertEvent(
                        alert_type="stream_paused",
                        message=f"Stream '{s.name}' transitioned to disabled.",
                        stream_id=sid,
                        stream_name=str(s.name),
                        trigger_source="monitor",
                        extra={"status": str(s.status)},
                    )
                )
            self._last_stream_enabled[sid] = enabled
        # Purge ids no longer present.
        for stale in list(self._last_stream_enabled.keys() - seen_ids):
            self._last_stream_enabled.pop(stale, None)
        return events

    def _detect_checkpoint_stalled(self, db: Session) -> list[AlertEvent]:
        now = datetime.now(UTC)
        events: list[AlertEvent] = []
        streams = list(db.scalars(select(Stream).where(Stream.enabled.is_(True))))
        for s in streams:
            cp = db.query(Checkpoint).filter(Checkpoint.stream_id == s.id).first()
            if cp is None:
                continue
            updated = cp.updated_at
            if updated is None:
                continue
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=UTC)
            if now - updated < _CHECKPOINT_STALL_THRESHOLD:
                continue
            # Bound the probe to the recent window. Counting every historical
            # run_complete since an old checkpoint scans large partitions.
            recent_floor = now - _RECENT_WINDOW
            activity_since = updated if updated > recent_floor else recent_floor
            recent_activity = db.scalar(
                select(DeliveryLog.id)
                .where(
                    DeliveryLog.stream_id == s.id,
                    DeliveryLog.stage == "run_complete",
                    DeliveryLog.created_at >= activity_since,
                )
                .limit(1)
            )
            if recent_activity is None:
                continue
            events.append(
                AlertEvent(
                    alert_type="checkpoint_stalled",
                    message=(
                        f"Stream '{s.name}' checkpoint has not advanced since {updated.isoformat()}"
                        f" despite recent run activity."
                    ),
                    stream_id=int(s.id),
                    stream_name=str(s.name),
                    trigger_source="monitor",
                    extra={"recent_runs": 1, "activity_probe": "exists_within_recent_window"},
                )
            )
        return events

    def _route_metadata(self, db: Session, route_id: int) -> dict[str, Any]:
        r = db.query(Route).filter(Route.id == route_id).first()
        if r is None:
            return {}
        out: dict[str, Any] = {
            "stream_id": int(r.stream_id),
            "destination_id": int(r.destination_id),
        }
        stream = db.query(Stream).filter(Stream.id == r.stream_id).first()
        if stream is not None:
            out["stream_name"] = str(stream.name)
        return out

    def _detect_destination_failed(self, db: Session) -> list[AlertEvent]:
        since = datetime.now(UTC) - _RECENT_WINDOW
        rows = list(
            db.execute(
                select(
                    DeliveryLog.route_id,
                    DeliveryLog.stage,
                    func.count(DeliveryLog.id).label("c"),
                )
                .where(
                    DeliveryLog.created_at >= since,
                    DeliveryLog.route_id.isnot(None),
                    DeliveryLog.stage.in_(
                        (
                            "route_send_success",
                            "route_send_failed",
                            "route_retry_success",
                            "route_retry_failed",
                        )
                    ),
                )
                .group_by(DeliveryLog.route_id, DeliveryLog.stage)
            )
        )
        per_route: dict[int, dict[str, int]] = {}
        for route_id, stage, c in rows:
            if route_id is None:
                continue
            d = per_route.setdefault(int(route_id), {"success": 0, "failure": 0})
            if stage and "success" in stage:
                d["success"] += int(c or 0)
            else:
                d["failure"] += int(c or 0)
        events: list[AlertEvent] = []
        for route_id, stats in per_route.items():
            if stats["failure"] < _DEST_FAILED_MIN:
                continue
            if stats["failure"] <= stats["success"]:
                continue
            meta = self._route_metadata(db, route_id)
            if not meta:
                continue
            events.append(
                AlertEvent(
                    alert_type="destination_failed",
                    message=(
                        f"Destination delivery failing for route #{route_id}:"
                        f" {stats['failure']} failures vs {stats['success']} successes in last hour."
                    ),
                    severity="CRITICAL",
                    stream_id=meta.get("stream_id"),
                    stream_name=meta.get("stream_name"),
                    route_id=int(route_id),
                    destination_id=meta.get("destination_id"),
                    trigger_source="monitor",
                    extra={"failure_count": stats["failure"], "success_count": stats["success"]},
                )
            )
        return events

    def _detect_high_retry_count(self, db: Session) -> list[AlertEvent]:
        since = datetime.now(UTC) - _RECENT_WINDOW
        rows = list(
            db.execute(
                select(
                    DeliveryLog.route_id,
                    func.count(DeliveryLog.id).label("c"),
                )
                .where(
                    DeliveryLog.created_at >= since,
                    DeliveryLog.route_id.isnot(None),
                    DeliveryLog.stage.in_(("route_retry_success", "route_retry_failed")),
                )
                .group_by(DeliveryLog.route_id)
            )
        )
        events: list[AlertEvent] = []
        for route_id, c in rows:
            count = int(c or 0)
            if count < _HIGH_RETRY_THRESHOLD:
                continue
            meta = self._route_metadata(db, int(route_id))
            if not meta:
                continue
            events.append(
                AlertEvent(
                    alert_type="high_retry_count",
                    message=(
                        f"Route #{route_id} performed {count} retries in the last hour"
                        f" (threshold {_HIGH_RETRY_THRESHOLD})."
                    ),
                    stream_id=meta.get("stream_id"),
                    stream_name=meta.get("stream_name"),
                    route_id=int(route_id),
                    destination_id=meta.get("destination_id"),
                    trigger_source="monitor",
                    extra={"retry_count": count},
                )
            )
        return events

    def _detect_rate_limit_triggered(self, db: Session) -> list[AlertEvent]:
        since = datetime.now(UTC) - _RECENT_WINDOW
        # We treat any delivery_logs row whose stage or error_code mentions
        # "rate_limit" as a rate-limit trigger.  This is read-only.
        rows = list(
            db.execute(
                select(
                    DeliveryLog.stream_id,
                    DeliveryLog.route_id,
                    func.count(DeliveryLog.id).label("c"),
                )
                .where(
                    DeliveryLog.created_at >= since,
                    func.lower(DeliveryLog.stage).contains("rate_limit"),
                )
                .group_by(DeliveryLog.stream_id, DeliveryLog.route_id)
            )
        )
        events: list[AlertEvent] = []
        for stream_id, route_id, c in rows:
            if int(c or 0) <= 0:
                continue
            meta = self._route_metadata(db, int(route_id)) if route_id else {}
            events.append(
                AlertEvent(
                    alert_type="rate_limit_triggered",
                    message=(
                        f"Rate limit triggered {int(c)} time(s) in the last hour"
                        f" for stream #{stream_id}."
                    ),
                    stream_id=int(stream_id) if stream_id is not None else None,
                    stream_name=meta.get("stream_name"),
                    route_id=int(route_id) if route_id is not None else None,
                    destination_id=meta.get("destination_id"),
                    trigger_source="monitor",
                    extra={"events": int(c)},
                )
            )
        return events


_monitor: PlatformAlertMonitor | None = None


def register_alert_monitor(monitor: PlatformAlertMonitor | None) -> None:
    global _monitor
    _monitor = monitor


def get_alert_monitor() -> PlatformAlertMonitor | None:
    return _monitor


__all__ = [
    "PlatformAlertMonitor",
    "get_alert_monitor",
    "register_alert_monitor",
]
