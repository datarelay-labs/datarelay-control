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
