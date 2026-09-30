from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_enrichment_exec_preview_static_and_calculated() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/enrichment-exec",
        json={
            "mapped_event": {"eventName": "CreateBucket", "region": "us-east-1"},
            "enrichment": {
                "vendor": "Acme",
                "__rules": {
                    "metadata.severity": {
                        "type": "calculated",
                        "expression": "eventName.includes('Delete') ? 8 : 5",
                        "enabled": True,
                    }
                },
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["final_event"]["vendor"] == "Acme"
    assert body["final_event"]["metadata"]["severity"] == 5
    assert "__rules" not in body["final_event"]


def test_enrichment_exec_preview_rules_not_leaked() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/enrichment-exec",
        json={
            "mapped_event": {"id": "1"},
            "enrichment": {
                "__rules": {
                    "metadata.x": {
                        "type": "calculated",
                        "expression": "concat('a')",
                        "enabled": True,
                    }
                }
            },
        },
    )
    assert response.status_code == 200
    assert "__rules" not in response.json()["final_event"]


def test_enrichment_exec_preview_surfaces_advanced_transform_field_error() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/enrichment-exec",
        json={
            "mapped_event": {"message": "src=10.0.0.1"},
            "enrichment": {
                "advanced_fields": [
                    {
                        "mode": "regex_extract",
                        "output_field": "source_ip",
                        "source_path": "$.message",
                        "pattern": "(",
                        "group": 1,
                    }
                ]
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert "advanced_fields" not in body["final_event"]
    assert body["warnings"]
    assert body["warnings"][0]["code"] == "REGEX_PATTERN_INVALID"
    assert body["warnings"][0]["target_field"] == "source_ip"
