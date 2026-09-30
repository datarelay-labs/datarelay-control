from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.main import app
from tests.test_stream_runner_e2e import _seed_stream_runtime


def test_e2e_draft_preview_syslog_udp_success() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"items": [{"id": "evt-1", "message": "hello"}]},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id", "message": "$.message"},
            "enrichment": {"vendor": "Acme"},
            "destination_type": "SYSLOG_UDP",
            "formatter_config": {
                "message_format": "json",
                "syslog": {"hostname": "gdc", "app_name": "generic-connector", "tag": "acme_edr"},
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["input_event_count"] == 1
    assert body["preview_event_count"] == 1
    assert body["destination_type"] == "SYSLOG_UDP"
    assert body["final_events"][0]["vendor"] == "Acme"
    assert body["preview_messages"][0].startswith("<134> gdc generic-connector acme_edr: ")


def test_e2e_draft_preview_route_id_runs_effective_pipeline_once(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"items": [{"id": "evt-route", "message": "hello", "vendor": "Acme"}]},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id", "message": "$.message", "vendor": "$.vendor"},
            "enrichment": {"vendor": "MappedVendorShouldWin", "product": "GDC"},
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
            "stream_id": fixture["stream_id"],
            "route_id": fixture["route_ids"][0],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["route_id"] == fixture["route_ids"][0]
    final_event = body["final_events"][0]
    assert final_event["event_id"] == "evt-route"
    assert final_event["message"] == "hello"
    assert final_event["vendor"] == "Acme"
    assert final_event["product"] == "GDC"
    assert final_event["classification_level"] == "INTERNAL"
    stages = [item["stage"] for item in body["route_stage_timeline"]]
    assert stages[:4] == ["transform", "transform", "protection", "classification"]
    assert "policy" in stages
    assert body["delivery_allowed"] is True


def test_e2e_draft_preview_syslog_tcp_success() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"items": [{"id": "evt-2", "message": "world"}]},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id", "message": "$.message"},
            "destination_type": "SYSLOG_TCP",
            "formatter_config": {
                "message_format": "json",
                "syslog": {"hostname": "gdc", "app_name": "generic-connector", "tag": "acme_edr"},
            },
        },
    )
    assert response.status_code == 200
    assert response.json()["destination_type"] == "SYSLOG_TCP"


def test_e2e_draft_preview_webhook_post_success() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"items": [{"id": "evt-3", "message": "webhook"}]},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id", "message": "$.message"},
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["preview_messages"] == [{"event_id": "evt-3", "message": "webhook"}]


def test_e2e_draft_preview_event_array_path_success() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"data": {"items": [{"id": "a1"}, {"id": "a2"}]}},
            "event_array_path": "$.data.items",
            "field_mappings": {"event_id": "$.id"},
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["input_event_count"] == 2
    assert [row["event_id"] for row in body["final_events"]] == ["a1", "a2"]


def test_e2e_draft_preview_root_list_payload_success() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": [{"id": "r1"}, {"id": "r2"}],
            "field_mappings": {"event_id": "$.id"},
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["input_event_count"] == 2
    assert body["preview_event_count"] == 2


def test_e2e_draft_preview_max_events_limit_applied() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": [{"id": f"e{i}"} for i in range(8)],
            "field_mappings": {"event_id": "$.id"},
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
            "max_events": 3,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["input_event_count"] == 8
    assert body["preview_event_count"] == 3
    assert len(body["mapped_events"]) == 3
    assert len(body["final_events"]) == 3
    assert len(body["preview_messages"]) == 3


def test_e2e_draft_preview_missing_jsonpath_records_null_and_missing_fields() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": [{"id": "e1"}, {"id": "e2"}],
            "field_mappings": {"event_id": "$.id", "missing_val": "$.not_found"},
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mapped_events"][0]["missing_val"] is None
    assert body["mapped_events"][1]["missing_val"] is None
    assert body["missing_fields"] == [
        {"output_field": "missing_val", "json_path": "$.not_found", "event_index": 0},
        {"output_field": "missing_val", "json_path": "$.not_found", "event_index": 1},
    ]


def test_e2e_draft_preview_keep_existing_policy() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"items": [{"id": "evt-1", "vendor": "Original"}]},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id", "vendor": "$.vendor"},
            "enrichment": {"vendor": "Acme"},
            "override_policy": "KEEP_EXISTING",
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 200
    assert response.json()["final_events"][0]["vendor"] == "Original"


def test_e2e_draft_preview_override_policy() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"items": [{"id": "evt-1", "vendor": "Original"}]},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id", "vendor": "$.vendor"},
            "enrichment": {"vendor": "Acme"},
            "override_policy": "OVERRIDE",
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 200
    assert response.json()["final_events"][0]["vendor"] == "Acme"


def test_e2e_draft_preview_error_on_conflict_returns_400() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"items": [{"id": "evt-1", "vendor": "Original"}]},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id", "vendor": "$.vendor"},
            "enrichment": {"vendor": "Acme"},
            "override_policy": "ERROR_ON_CONFLICT",
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "ENRICHMENT_FAILED"


def test_e2e_draft_preview_invalid_jsonpath_returns_400() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"id": "evt-1"},
            "field_mappings": {"event_id": "$.["},
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "MAPPING_FAILED"


def test_e2e_draft_preview_invalid_event_array_path_returns_400() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"items": "not-an-array"},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id"},
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "EVENT_EXTRACTION_FAILED"


def test_e2e_draft_preview_does_not_use_db_commit_or_rollback(monkeypatch) -> None:
    called = {"commit": 0, "rollback": 0}

    def _raise_commit(*args, **kwargs):  # noqa: ANN002, ANN003
        called["commit"] += 1
        raise AssertionError("DB commit should not be called")

    def _raise_rollback(*args, **kwargs):  # noqa: ANN002, ANN003
        called["rollback"] += 1
        raise AssertionError("DB rollback should not be called")

    monkeypatch.setattr("sqlalchemy.orm.session.Session.commit", _raise_commit)
    monkeypatch.setattr("sqlalchemy.orm.session.Session.rollback", _raise_rollback)
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/e2e-draft",
        json={
            "payload": {"id": "evt-1"},
            "field_mappings": {"event_id": "$.id"},
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 200
    assert called["commit"] == 0
    assert called["rollback"] == 0


def test_final_event_draft_preview_regression_still_works() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/final-event-draft",
        json={
            "payload": {"items": [{"id": "evt-1"}]},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id"},
            "enrichment": {"vendor": "Acme"},
            "override_policy": "KEEP_EXISTING",
        },
    )
    assert response.status_code == 200
    assert response.json()["final_events"][0]["event_id"] == "evt-1"


def test_delivery_format_draft_preview_regression_still_works() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/delivery-format-draft",
        json={
            "final_events": [{"event_id": "evt-1"}],
            "destination_type": "WEBHOOK_POST",
            "formatter_config": {},
        },
    )
    assert response.status_code == 200
    assert response.json()["preview_event_count"] == 1


def test_mapping_draft_preview_regression_still_works() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/mapping-draft",
        json={
            "payload": {"id": "evt-1"},
            "field_mappings": {"event_id": "$.id"},
        },
    )
    assert response.status_code == 200
    assert response.json()["mapped_events"][0]["event_id"] == "evt-1"


def test_mapping_preview_regression_still_works() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/mapping",
        json={
            "raw_response": {"items": [{"id": "evt-1"}]},
            "event_array_path": "$.items",
            "field_mappings": {"event_id": "$.id"},
            "enrichment": {},
            "override_policy": "KEEP_EXISTING",
        },
    )
    assert response.status_code == 200
    assert response.json()["preview_events"][0]["event_id"] == "evt-1"
