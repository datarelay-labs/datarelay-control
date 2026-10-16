from __future__ import annotations

import pytest
from botocore.exceptions import EndpointConnectionError

from app.sources.s3_probe import probe_s3_source


def test_s3_connectivity_probe_bounds_botocore_network_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class _Client:
        def head_bucket(self, **kwargs: object) -> None:
            raise EndpointConnectionError(endpoint_url="http://127.0.0.1:59000")

    class _Session:
        def client(self, service_name: str, **kwargs: object) -> _Client:
            captured["service_name"] = service_name
            captured["config"] = kwargs["config"]
            return _Client()

    monkeypatch.setattr("app.sources.s3_probe.boto3.session.Session", lambda **kwargs: _Session())

    result = probe_s3_source(
        {
            "endpoint_url": "http://127.0.0.1:59000",
            "bucket": "fixture",
            "region": "us-east-1",
            "access_key": "fixture-access",
            "secret_key": "fixture-secret",
            "path_style_access": True,
            "use_ssl": False,
        }
    )

    cfg = captured["config"]
    assert captured["service_name"] == "s3"
    assert cfg.connect_timeout == 3
    assert cfg.read_timeout == 10
    assert cfg.retries == {"total_max_attempts": 2, "mode": "standard"}
    assert result["s3_endpoint_reachable"] is False
    assert result["s3_error_type"] == "network_error"


def test_s3_connectivity_probe_limits_object_listing_to_preview_size(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class _Client:
        def head_bucket(self, **kwargs: object) -> None:
            captured["head_bucket"] = kwargs

        def list_objects_v2(self, **kwargs: object) -> dict[str, object]:
            captured["list_objects_v2"] = kwargs
            return {"Contents": [{"Key": f"events/{i}.json"} for i in range(8)]}

    class _Session:
        def client(self, service_name: str, **kwargs: object) -> _Client:
            return _Client()

    monkeypatch.setattr("app.sources.s3_probe.boto3.session.Session", lambda **kwargs: _Session())

    result = probe_s3_source(
        {
            "endpoint_url": "http://127.0.0.1:59000",
            "bucket": "fixture",
            "region": "us-east-1",
            "access_key": "fixture-access",
            "secret_key": "fixture-secret",
            "path_style_access": True,
            "use_ssl": False,
        }
    )

    assert captured["list_objects_v2"] == {"Bucket": "fixture", "Prefix": "", "MaxKeys": 8}
    assert result["s3_auth_ok"] is True
    assert result["s3_bucket_exists"] is True
    assert result["s3_object_count_preview"] == 8
    assert len(result["s3_sample_keys"]) == 8
    assert "Listed up to 8 keys" in str(result["s3_message"])
