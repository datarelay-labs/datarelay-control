"""Union Schema persistence — PUT /streams/{id} → stream load → SharedBatchContext."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.main import app
from app.runners.route_context_builder import build_shared_batch_context
from app.runners.stream_loader import load_stream_context
from tests.test_stream_runner_e2e import _seed_stream_runtime


from tests.config_mutation_test_helpers import put_stream
@pytest.fixture
def streams_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_union_schema_persist_round_trip(streams_client: TestClient, db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])

    union_schema_payload = {
        "total_events": 2,
        "fields": [
            {
                "field_path": "$.id",
                "field_type": "string",
                "occurrence_count": 2,
                "sample_values": ["evt-1"],
            },
            {
                "field_path": "$.message",
                "field_type": "string",
                "occurrence_count": 1,
                "sample_values": ["hello"],
            },
        ],
        "snapshot_at": "2026-06-17T12:00:00Z",
    }

    current = streams_client.get(f"/api/v1/streams/{stream_id}")
    assert current.status_code == 200
    cfg = dict(current.json().get("config_json") or {})
    cfg["union_schema"] = union_schema_payload

    put = put_stream(streams_client, stream_id, {"config_json": cfg})
    assert put.status_code == 200
    saved = put.json().get("config_json", {}).get("union_schema")
    assert saved == union_schema_payload

    ctx = load_stream_context(db_session, stream_id, require_enabled_stream=False)
    runtime_stream = ctx.stream
    shared = build_shared_batch_context(
        stream_id=stream_id,
        batch_id="persist-round-trip",
        runtime_stream=runtime_stream,
        extracted_events=[{"id": "evt-1", "message": "hello"}],
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
    )
    assert len(shared.union_schema) == 2
    assert shared.union_schema[0]["field_path"] == "$.id"
