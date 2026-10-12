"""Owner-gated PF-11A Governance notification outbox polling worker.

Both durable queue and worker flags must be explicitly enabled. The app's
existing scheduler readiness gate prevents startup on an unready schema.
No credentials, network access or state are provisioned by this module.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Callable

from sqlalchemy.orm import sessionmaker

from app.database import SessionLocal
from app.governance_notifications.outbox import drain_outbox_once, durable_outbox_enabled

logger = logging.getLogger(__name__)


class GovernanceOutboxWorker:
    def __init__(
        self, *, session_factory: sessionmaker | None = None,
        drain: Callable[..., int] = drain_outbox_once,
        poll_seconds: float = 15.0,
    ) -> None:
        if not 5 <= poll_seconds <= 300:
            raise ValueError("Outbox worker poll interval out of bounds")
        self._sessions = session_factory if session_factory is not None else SessionLocal
        self._drain = drain
        self._poll_seconds = poll_seconds
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def is_enabled(self) -> bool:
        return (durable_outbox_enabled() and
                os.environ.get("GDC_GOV_NOTIFICATION_WORKER_ENABLED") == "true")

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def trigger_once(self) -> int:
        """Bounded manual tick; never executes when either gate is disabled."""
        if not self.is_enabled():
            return 0
        try:
            return self._drain(self._sessions)
        except Exception as exc:
            # Configuration, DB errors and vendor transports can include secrets.
            logger.warning("governance_notification_outbox_tick_failed reason=%s",
                           type(exc).__name__)
            return 0

    def start(self) -> bool:
        if not self.is_enabled():
            return False
        if self.is_running():
            return True
        self._stop_event.clear()
        self._thread = threading.Thread(
            name="governance-notification-outbox",
            target=self._loop,
            daemon=True,
        )
        self._thread.start()
        return True

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            self.trigger_once()
            self._stop_event.wait(self._poll_seconds)

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=5)
            if not thread.is_alive():
                self._thread = None
