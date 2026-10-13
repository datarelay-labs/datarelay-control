"""Pilot boundary must refuse unsanctioned/shared databases and endpoints.

Only pure runtime checks. Does not connect to PostgreSQL or Grant, create
accounts, send to webhook, or alter any existing Control service.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.runtime.grant_replay_pilot import IsolatedPilotError, _only_ephemeral


def make_session(url):
    engine = create_engine(url)
    return engine, sessionmaker(bind=engine), Session(bind=engine)


def test_pilot_refuses_any_run_without_owner_explicit_isolated_flag(monkeypatch):
    monkeypatch.delenv("G11_APPROVED_DISPOSABLE_E2E", raising=False)
    engine, factory, db = make_session("sqlite://")
    try:
        with pytest.raises(IsolatedPilotError, match="NOT_EXPLICITLY_ENABLED"):
            _only_ephemeral(factory, db, "http://127.0.0.1:19001/g11")
    finally:
        db.close()
        engine.dispose()


@pytest.mark.parametrize("url,port", [
    ("sqlite://", "32771"),
    ("postgresql://test:test@127.0.0.1:55441/gdc_pytest", "55441"),
    ("postgresql://test:test@127.0.0.1:32771/gdc", "32771"),
    ("postgresql://test:test@10.1.1.1:32771/gdc_pytest", "32771"),
    ("postgresql://test:test@127.0.0.1:32771/gdc_pytest", "32772"),
])
def test_pilot_refuses_nonisolated_or_wrong_postgres(monkeypatch, url, port):
    monkeypatch.setenv("G11_APPROVED_DISPOSABLE_E2E", "yes")
    monkeypatch.setenv("G11_DISPOSABLE_PG_PORT", port)
    engine, factory, db = make_session(url)
    try:
        with pytest.raises(IsolatedPilotError, match="POSTGRES_NOT_ISOLATED"):
            _only_ephemeral(factory, db, "http://127.0.0.1:19001/g11")
    finally:
        db.close()
        engine.dispose()


@pytest.mark.parametrize("target", [
    "https://127.0.0.1:19001/g11",
    "http://localhost:19001/g11",
    "http://127.0.0.1:19001/other",
    "http://127.0.0.1:19001/g11?other=true",
    "http://192.168.1.2:19001/g11",
    "http://127.0.0.1:19001/g11#fragment",
])
def test_pilot_receiver_must_be_exact_loopback_endpoint(monkeypatch, target):
    monkeypatch.setenv("G11_APPROVED_DISPOSABLE_E2E", "yes")
    monkeypatch.setenv("G11_DISPOSABLE_PG_PORT", "32771")
    engine, factory, db = make_session(
        "postgresql://test:test@127.0.0.1:32771/gdc_pytest"
    )
    try:
        with pytest.raises(IsolatedPilotError, match="RECEIVER_NOT_LOOPBACK"):
            _only_ephemeral(factory, db, target)
    finally:
        db.close()
        engine.dispose()
