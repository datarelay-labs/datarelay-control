"""Short-lived SQLAlchemy sessions for StreamRunner (avoid idle-in-transaction)."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Callable, Generator, TypeVar

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import SessionLocal

T = TypeVar("T")


@contextmanager
def short_db_session(*, commit: bool = False, read_only: bool | None = None) -> Generator[Session, None, None]:
    """Open a DB session, optionally commit on success, always close on exit."""

    use_read_only = read_only if read_only is not None else not commit
    db = SessionLocal()
    try:
        if use_read_only:
            db.execute(text("SET TRANSACTION READ ONLY"))
        yield db
        if commit:
            db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.rollback()
        db.close()


def run_with_db(fn: Callable[[Session], T], *, commit: bool = False) -> T:
    """Run ``fn(db)`` inside a short-lived session."""

    with short_db_session(commit=commit) as db:
        return fn(db)


@contextmanager
def stage_persistence_session(
    existing_db: Session | None,
    *,
    required: bool,
) -> Generator[Session | None, None, None]:
    """Yield caller DB when present, otherwise a bounded committing session only when required.

    Route stages use this to persist protection/token-vault or quarantine state without
    holding a scheduler-owned transaction across source or destination network I/O.
    """

    if existing_db is not None:
        yield existing_db
        return
    if not required:
        yield None
        return
    with short_db_session(commit=True) as db:
        yield db
