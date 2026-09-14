"""Helpers for optimistic-concurrency tokens in API tests."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def stream_token(client: TestClient, stream_id: int) -> str:
    res = client.get(f"/api/v1/streams/{stream_id}")
    assert res.status_code == 200, res.text
    token = res.json().get("updated_at")
    assert isinstance(token, str) and token
    return token


def put_stream(client: TestClient, stream_id: int, payload: dict[str, Any], *, token: str | None = None):
    body = dict(payload)
    body["expected_updated_at"] = token if token is not None else stream_token(client, stream_id)
    return client.put(f"/api/v1/streams/{stream_id}", json=body)


def destination_token(client: TestClient, destination_id: int) -> str:
    res = client.get(f"/api/v1/destinations/{destination_id}")
    assert res.status_code == 200, res.text
    token = res.json().get("updated_at")
    assert isinstance(token, str) and token
    return token


def put_destination(client: TestClient, destination_id: int, payload: dict[str, Any], *, token: str | None = None):
    body = dict(payload)
    body["expected_updated_at"] = token if token is not None else destination_token(client, destination_id)
    return client.put(f"/api/v1/destinations/{destination_id}", json=body)


def connector_tokens(client: TestClient, connector_id: int) -> tuple[str, str | None]:
    res = client.get(f"/api/v1/connectors/{connector_id}")
    assert res.status_code == 200, res.text
    body = res.json()
    token = body.get("updated_at")
    assert isinstance(token, str) and token
    source_token = body.get("source_updated_at")
    return token, source_token


def put_connector(client: TestClient, connector_id: int, payload: dict[str, Any], *, tokens: tuple[str, str | None] | None = None):
    body = dict(payload)
    c_token, s_token = tokens if tokens is not None else connector_tokens(client, connector_id)
    body["expected_updated_at"] = c_token
    if s_token is not None:
        body["expected_source_updated_at"] = s_token
    return client.put(f"/api/v1/connectors/{connector_id}", json=body)
