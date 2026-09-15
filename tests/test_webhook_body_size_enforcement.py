"""Regression: webhook ingest enforces body size before unbounded body reads."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.ingest.body_limits import read_request_body_capped
from app.main import app
from tests.test_webhook_receiver_ingest import _seed_webhook_stream


@pytest.fixture
def client(db_session: Session) -> Iterator[TestClient]:
    def _override_db() -> Iterator[Session]:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_read_request_body_capped_rejects_content_length() -> None:
    async def _run() -> None:
        request = AsyncMock(spec=Request)
        request.headers = {"content-length": "5000"}

        async def _empty():
            if False:  # pragma: no cover
                yield b""

        request.stream = _empty
        with pytest.raises(Exception) as excinfo:
            await read_request_body_capped(request, 1024)
        assert getattr(excinfo.value, "status_code", None) == 413

    asyncio.run(_run())


def test_read_request_body_capped_rejects_stream_overflow() -> None:
    async def _run() -> None:
        async def _chunks():
            yield b"x" * 800
            yield b"y" * 800

        request = AsyncMock(spec=Request)
        request.headers = {}
        request.stream = _chunks
        with pytest.raises(Exception) as excinfo:
            await read_request_body_capped(request, 1024)
        assert getattr(excinfo.value, "status_code", None) == 413

    asyncio.run(_run())


def test_webhook_ingest_rejects_oversized_body(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    seeded = _seed_webhook_stream(db_session, receiver_key="size-key", auth_mode="no_auth")
    assert seeded["stream_id"]
    from app.sources.models import Source

    source = db_session.query(Source).filter(Source.id == seeded["source_id"]).one()
    source.config_json = {**(source.config_json or {}), "max_request_bytes": 2048}
    db_session.commit()

    called_body = {"hit": False}

    async def _should_not_body(self: Any) -> bytes:  # noqa: ANN401
        called_body["hit"] = True
        raise AssertionError("request.body() must not be used for webhook size enforcement")

    monkeypatch.setattr(Request, "body", _should_not_body, raising=False)

    oversized = b"{" + (b"a" * 3000) + b"}"
    res = client.post(
        "/api/v1/ingest/webhook/size-key",
        content=oversized,
        headers={"Content-Type": "application/json"},
    )
    assert called_body["hit"] is False
    assert res.status_code == 413
    detail = res.json()["detail"]
    assert detail["error_code"] == "WEBHOOK_PAYLOAD_TOO_LARGE"
