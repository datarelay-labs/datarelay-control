"""Cross-process continuous-validation exclusivity via PostgreSQL advisory locks.

Process-local ``threading.Lock`` is insufficient when API workers and the
standalone scheduler run in separate processes. Session-level advisory locks
are held on a dedicated connection for the duration of a validation run.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from app.database import engine as default_engine

# Namespace prefix keeps CV locks out of other advisory-lock key spaces.
_CV_LOCK_NAMESPACE = 0x4356_414C  # "CVAL"


def validation_advisory_lock_key(validation_id: int) -> int:
    """Stable signed 64-bit key for ``pg_try_advisory_lock``."""

    return (_CV_LOCK_NAMESPACE << 32) | (int(validation_id) & 0xFFFFFFFF)


@contextmanager
def try_validation_execution_lock(
    validation_id: int,
    *,
    bind: Engine | None = None,
) -> Iterator[bool]:
    """Yield ``True`` when this process holds the CV lock; ``False`` if contended.

    The underlying DB connection stays open while the lock is held so the
    session-level advisory lock is not released early by connection pooling.
    """

    eng = bind or default_engine
    key = validation_advisory_lock_key(validation_id)
    conn: Connection = eng.connect()
    acquired = False
    try:
        acquired = bool(conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key}).scalar())
        yield acquired
    finally:
        if acquired:
            try:
                conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})
            except Exception:
                # Connection close still drops session locks; avoid masking the
                # original validation error when unlock fails during teardown.
                pass
        conn.close()


__all__ = ["try_validation_execution_lock", "validation_advisory_lock_key"]
