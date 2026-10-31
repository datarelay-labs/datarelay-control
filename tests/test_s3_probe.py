from __future__ import annotations

import pytest
from botocore.exceptions import ClientError, ConnectionClosedError, EndpointConnectionError, SSLError

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


def _probe_with_client(monkeypatch: pytest.MonkeyPatch, client: object, **overrides: object) -> dict[str, object]:
    class _Session:
        def client(self, service_name: str, **kwargs: object) -> object:
            return client

    monkeypatch.setattr("app.sources.s3_probe.boto3.session.Session", lambda **kwargs: _Session())
    cfg: dict[str, object] = {
        "endpoint_url": "https://s3.example.test",
        "bucket": "fixture",
        "region": "us-east-1",
        "access_key": "fixture-access",
        "secret_key": "fixture-secret",
        "path_style_access": True,
        "use_ssl": True,
    }
    cfg.update(overrides)
    return probe_s3_source(cfg)


def _client_error(code: str, op: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "x"}}, op)


@pytest.mark.parametrize(
    ("list_code", "expected_type", "must_mention"),
    [
        ("SignatureDoesNotMatch", "signature_mismatch", "Secret key"),
        ("InvalidAccessKeyId", "invalid_access_key", "Access key"),
        ("AuthorizationHeaderMalformed", "region_mismatch", "Region"),
        ("AccessDenied", "access_denied", "s3:ListBucket"),
    ],
)
def test_s3_probe_uses_the_listing_error_to_name_the_wrong_input_when_head_bucket_is_opaque(
    monkeypatch: pytest.MonkeyPatch, list_code: str, expected_type: str, must_mention: str
) -> None:
    # F-108: HEAD answers a bare 403 for every credential problem; only the GET body is specific.
    class _Client:
        def head_bucket(self, **kwargs: object) -> None:
            raise _client_error("403", "HeadBucket")

        def list_objects_v2(self, **kwargs: object) -> dict[str, object]:
            raise _client_error(list_code, "ListObjectsV2")

    result = _probe_with_client(monkeypatch, _Client())
    assert result["s3_error_type"] == expected_type
    assert must_mention in str(result["s3_message"])
    assert result["s3_endpoint_reachable"] is True
    assert result["s3_auth_ok"] is False
    # The bucket was never confirmed missing; it must not be reported as nonexistent.
    assert result["s3_bucket_exists"] is False
    assert result["s3_error_type"] != "no_such_bucket"


def test_s3_probe_reports_a_missing_bucket_distinctly(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Client:
        def head_bucket(self, **kwargs: object) -> None:
            raise _client_error("404", "HeadBucket")

    result = _probe_with_client(monkeypatch, _Client())
    assert result["s3_error_type"] == "no_such_bucket"
    assert "Bucket not found" in str(result["s3_message"])


def test_s3_probe_wrong_region_400_points_at_the_region(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Client:
        def head_bucket(self, **kwargs: object) -> None:
            raise _client_error("400", "HeadBucket")

        def list_objects_v2(self, **kwargs: object) -> dict[str, object]:
            raise _client_error("400", "ListObjectsV2")

    result = _probe_with_client(monkeypatch, _Client())
    assert result["s3_error_type"] == "bad_request"
    assert "Region" in str(result["s3_message"])


def test_s3_probe_distinguishes_tls_and_ssl_toggle_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    class _TlsClient:
        def head_bucket(self, **kwargs: object) -> None:
            raise SSLError(endpoint_url="https://s3.example.test", error="CERTIFICATE_VERIFY_FAILED")

    tls = _probe_with_client(monkeypatch, _TlsClient())
    assert tls["s3_error_type"] == "tls_error"
    assert "certificate" in str(tls["s3_message"]).lower()
    assert tls["s3_endpoint_reachable"] is True

    class _ClosedClient:
        def head_bucket(self, **kwargs: object) -> None:
            raise ConnectionClosedError(endpoint_url="https://s3.example.test")

    closed = _probe_with_client(monkeypatch, _ClosedClient(), use_ssl=False)
    assert closed["s3_error_type"] == "connection_closed"
    assert "Use SSL" in str(closed["s3_message"])
