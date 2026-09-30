from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_mapping_validate_duplicate_output_field_warning() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/mapping-validate",
        json={
            "payload": {"id": "1"},
            "field_mappings": {"event_id": "$.id", "Event_ID": "$.id"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    codes = [w["code"] for w in body["warnings"]]
    assert "DUPLICATE_OUTPUT_FIELD" in codes


def test_mapping_validate_invalid_jsonpath_error() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/mapping-validate",
        json={
            "payload": {"id": "1"},
            "field_mappings": {"event_id": "$.id[[["},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert any(w["code"] == "INVALID_JSONPATH" and w["severity"] == "error" for w in body["warnings"])


def test_mapping_validate_empty_extraction_warning() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/mapping-validate",
        json={
            "payload": {"id": "1"},
            "field_mappings": {"missing": "$.not_here"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert any(w["code"] == "EMPTY_EXTRACTION" for w in body["warnings"])


def test_mapping_validate_missing_payload_warning() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/mapping-validate",
        json={"field_mappings": {"event_id": "$.id"}},
    )
    assert response.status_code == 200
    body = response.json()
    assert any(w["code"] == "MISSING_PREVIEW_PAYLOAD" for w in body["warnings"])


def test_mapping_validate_ignores_transform_metadata_as_jsonpath_rows() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/mapping-validate",
        json={
            "payload": {"message": "src=10.0.0.1"},
            "field_mappings": {
                "message": "$.message",
                "mapping_mode": "basic_jsonpath",
                "transform_rules": [
                    {
                        "mode": "regex_extract",
                        "output_field": "source_ip",
                        "source_path": "$.message",
                        "pattern": r"src=(\S+)",
                        "group": 1,
                    }
                ],
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert not any(w["code"] == "INVALID_JSONPATH" for w in body["warnings"])
