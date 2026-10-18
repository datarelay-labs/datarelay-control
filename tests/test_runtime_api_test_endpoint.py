from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from app.main import app


def test_http_api_test_returns_raw_and_extracted_preview(monkeypatch) -> None:
    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def request(self, method, url, **kwargs):  # noqa: ANN001
            req = httpx.Request(method, url)
            return httpx.Response(200, request=req, json={"items": [{"id": "evt-1"}, {"id": "evt-2"}], "meta": {"ok": True}})

    monkeypatch.setattr("app.connectors.auth_execute.httpx.Client", lambda *a, **k: _Client())
    client = TestClient(app)

    response = client.post(
        "/api/v1/runtime/api-test/http",
        json={
            "source_config": {"base_url": "https://api.example.com"},
            "stream_config": {"method": "GET", "endpoint": "/events", "event_array_path": "$.items"},
            "checkpoint": {"cursor": "1"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["response"]["parsed_json"]["meta"]["ok"] is True
    assert body["response"]["status_code"] == 200


def test_http_api_test_returns_clear_error_on_fetch_failure(monkeypatch) -> None:
    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def request(self, method, url, **kwargs):  # noqa: ANN001
            raise httpx.TimeoutException("timed out during request")

    monkeypatch.setattr("app.connectors.auth_execute.httpx.Client", lambda *a, **k: _Client())
    client = TestClient(app)

    response = client.post(
        "/api/v1/runtime/api-test/http",
        json={
            "source_config": {"base_url": "https://api.example.com"},
            "stream_config": {"endpoint": "/events"},
        },
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["error_type"] == "timeout"


def test_http_api_test_returns_extraction_error(monkeypatch) -> None:
    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def request(self, method, url, **kwargs):  # noqa: ANN001
            req = httpx.Request(method, url)
            return httpx.Response(200, request=req, json=[1, 2, 3])

    monkeypatch.setattr("app.connectors.auth_execute.httpx.Client", lambda *a, **k: _Client())
    client = TestClient(app)

    response = client.post(
        "/api/v1/runtime/api-test/http",
        json={
            "source_config": {"base_url": "https://api.example.com"},
            "stream_config": {"endpoint": "/events"},
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_http_api_test_actual_request_sent_keeps_body_size_with_query_limit(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def request(self, method, url, **kwargs):  # noqa: ANN001
            captured["method"] = method
            captured["url"] = url
            captured["kwargs"] = kwargs
            req = httpx.Request(method, url)
            return httpx.Response(200, request=req, json={"hits": {"hits": [{"_id": "evt-1"}]}})

    monkeypatch.setattr("app.connectors.auth_execute.httpx.Client", lambda *a, **k: _Client())
    client = TestClient(app)

    response = client.post(
        "/api/v1/runtime/api-test/http",
        json={
            "source_config": {"base_url": "https://api.example.com"},
            "stream_config": {
                "method": "GET",
                "endpoint": "/_search",
                "params": {"limit": "10"},
                "body": {"size": 1, "query": {"bool": {"filter": []}}},
            },
            "fetch_sample": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert captured["method"] == "GET"
    assert captured["kwargs"]["json"]["size"] == 1
    assert "limit" not in captured["kwargs"]["json"]
    assert body["actual_request_sent"]["query_params"]["limit"] == "10"
    assert body["actual_request_sent"]["json_body_masked"]["size"] == 1


def test_s3_api_test_returns_bounded_actual_object_records_without_checkpoint_mutation(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def _fetch(self, source_config, stream_config, checkpoint):  # noqa: ANN001
        captured["source_config"] = dict(source_config)
        captured["stream_config"] = dict(stream_config)
        captured["checkpoint"] = checkpoint
        return [
            {"id": "evt-1", "message": "first", "s3_key": "logs/a.ndjson"},
            {"id": "evt-2", "message": "second", "s3_key": "logs/a.ndjson"},
        ]

    monkeypatch.setattr(
        "app.sources.adapters.s3_object_polling.S3ObjectPollingAdapter.fetch",
        _fetch,
    )
    client = TestClient(app)

    response = client.post(
        "/api/v1/runtime/api-test/http",
        json={
            "source_config": {
                "source_type": "S3_OBJECT_POLLING",
                "endpoint_url": "http://minio.example.test:9000",
                "bucket": "security-logs",
                "prefix": "logs/",
                "access_key": "test-access",
                "secret_key": "test-secret",
            },
            "stream_config": {"max_objects_per_run": 20},
            "fetch_sample": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["request"]["method"] == "S3_OBJECT_POLLING"
    assert body["request"]["url"] == "s3://security-logs/logs/"
    assert body["response"]["parsed_json"][0]["id"] == "evt-1"
    assert body["response"]["parsed_json"][1]["message"] == "second"
    assert body["analysis"]["sample_event"]["id"] == "evt-1"
    assert captured["stream_config"]["max_objects_per_run"] == 3
    assert captured["checkpoint"] is None


def test_s3_api_test_reports_object_parse_failure_distinct_from_connectivity(monkeypatch) -> None:
    from app.runtime.errors import SourceFetchError

    def _fetch(self, source_config, stream_config, checkpoint):  # noqa: ANN001
        raise SourceFetchError("S3 object 'logs/bad.ndjson': invalid JSON on line 2")

    monkeypatch.setattr(
        "app.sources.adapters.s3_object_polling.S3ObjectPollingAdapter.fetch",
        _fetch,
    )
    client = TestClient(app)

    response = client.post(
        "/api/v1/runtime/api-test/http",
        json={
            "source_config": {
                "source_type": "S3_OBJECT_POLLING",
                "endpoint_url": "http://minio.example.test:9000",
                "bucket": "security-logs",
                "access_key": "test-access",
                "secret_key": "test-secret",
            },
            "stream_config": {"max_objects_per_run": 3},
            "fetch_sample": True,
        },
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["error_type"] == "s3_sample_fetch_failed"
    assert detail["error_code"] == "s3_sample_fetch_failed"
    assert "invalid JSON on line 2" in detail["message"]
