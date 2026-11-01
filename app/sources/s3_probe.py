"""S3 / MinIO connectivity probe for UI and connector-auth test (no secrets in return values)."""

from __future__ import annotations

import logging
from typing import Any

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    ConnectionClosedError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ReadTimeoutError,
    SSLError,
)

logger = logging.getLogger(__name__)


def _get(data: Any, key: str, default: Any = None) -> Any:
    if isinstance(data, dict):
        return data.get(key, default)
    return getattr(data, key, default)


# Error codes that say the credentials themselves are wrong, with the field the operator should fix.
_CREDENTIAL_CODES: dict[str, tuple[str, str]] = {
    "InvalidAccessKeyId": (
        "invalid_access_key",
        "The Access key is not recognised by this endpoint (InvalidAccessKeyId). Check the Access key and the endpoint URL.",
    ),
    "SignatureDoesNotMatch": (
        "signature_mismatch",
        "The Secret key does not match the Access key (SignatureDoesNotMatch). Re-enter the Secret key; "
        "also confirm the Region matches the endpoint.",
    ),
    "AuthorizationHeaderMalformed": (
        "region_mismatch",
        "The Region does not match the endpoint or bucket (AuthorizationHeaderMalformed). Set the Region the bucket lives in.",
    ),
    "InvalidToken": (
        "invalid_token",
        "The credentials include an invalid or expired session token (InvalidToken).",
    ),
    "ExpiredToken": (
        "invalid_token",
        "The credentials include an invalid or expired session token (ExpiredToken).",
    ),
}


def _error_code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code") or "")


def _classify_client_error(code: str, bucket: str) -> tuple[str, str]:
    """Map an S3 error code to (error_type, operator-facing message) naming the input to correct."""

    if code in _CREDENTIAL_CODES:
        return _CREDENTIAL_CODES[code]
    if code in {"404", "NoSuchBucket", "NotFound"}:
        return "no_such_bucket", f"Bucket not found: {bucket!r}. Check the bucket name and that it exists on this endpoint."
    if code in {"403", "AccessDenied", "AllAccessDisabled"}:
        return (
            "access_denied",
            "The credentials were accepted but are not allowed to access this bucket "
            "(AccessDenied). Grant s3:ListBucket on the bucket, or use credentials that have it.",
        )
    if code == "400":
        return (
            "bad_request",
            "The endpoint rejected the request (HTTP 400). This usually means the Region does not match "
            "the endpoint or bucket; check the Region and the endpoint URL.",
        )
    return "head_bucket_failed", f"The bucket check failed with {code or 'an unknown error'}."


def _classify_network_error(exc: BotoCoreError, use_ssl: bool, endpoint_url: str) -> tuple[str, str, bool]:
    """Return (error_type, message, endpoint_reachable) for a transport-level failure."""

    if isinstance(exc, SSLError):
        return (
            "tls_error",
            "TLS verification failed: the endpoint certificate is not trusted or does not match the "
            "endpoint host name. Use a trusted certificate or the correct host name.",
            True,
        )
    if isinstance(exc, ConnectionClosedError):
        hint = (
            " The endpoint is https but Use SSL is off; enable Use SSL."
            if endpoint_url.lower().startswith("https://") and not use_ssl
            else " Check the endpoint URL and the Use SSL setting."
        )
        return "connection_closed", "The server closed the connection before answering." + hint, True
    if isinstance(exc, (ConnectTimeoutError, ReadTimeoutError)):
        return "timeout", "The endpoint did not answer in time. Check the endpoint URL, port and firewall.", False
    if isinstance(exc, EndpointConnectionError):
        return "network_error", "Could not connect to the endpoint. Check the endpoint URL, port and firewall.", False
    return "network_error", f"Connection error: {type(exc).__name__}", False


def probe_s3_source(source_config: dict[str, Any], *, preview_key_limit: int = 8) -> dict[str, Any]:
    """List objects under prefix (non-destructive). Returns structured diagnostics without credentials."""

    endpoint_url = str(_get(source_config, "endpoint_url", "") or "").strip()
    bucket = str(_get(source_config, "bucket", "") or "").strip()
    region = str(_get(source_config, "region", "") or "us-east-1").strip() or "us-east-1"
    access_key = str(_get(source_config, "access_key", "") or "").strip()
    secret_key = str(_get(source_config, "secret_key", "") or "").strip()
    prefix = str(_get(source_config, "prefix", "") or "")
    path_style = bool(_get(source_config, "path_style_access", True))
    use_ssl = bool(_get(source_config, "use_ssl", False))

    out: dict[str, Any] = {
        "s3_endpoint_reachable": False,
        "s3_auth_ok": False,
        "s3_bucket_exists": False,
        "s3_object_count_preview": 0,
        "s3_sample_keys": [],
        "s3_error_type": None,
        "s3_message": None,
    }

    if not endpoint_url or not bucket:
        out["s3_error_type"] = "validation_error"
        out["s3_message"] = "endpoint_url and bucket are required"
        return out
    if not access_key or not secret_key:
        out["s3_error_type"] = "validation_error"
        out["s3_message"] = "access_key and secret_key are required"
        return out

    addressing = "path" if path_style else "virtual"
    boto_cfg = BotoConfig(
        signature_version="s3v4",
        s3={"addressing_style": addressing},
        connect_timeout=3,
        read_timeout=10,
        retries={"total_max_attempts": 2, "mode": "standard"},
    )

    try:
        session = boto3.session.Session(
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
        )
        client = session.client(
            "s3",
            endpoint_url=endpoint_url,
            use_ssl=use_ssl,
            config=boto_cfg,
        )
    except (BotoCoreError, ValueError) as exc:
        out["s3_error_type"] = "client_init_failed"
        out["s3_message"] = f"Failed to initialize S3 client: {type(exc).__name__}"
        logger.info("%s", {"stage": "s3_probe_client_init_failed", "error_type": type(exc).__name__})
        return out

    out["s3_endpoint_reachable"] = True

    try:
        client.head_bucket(Bucket=bucket)
        out["s3_bucket_exists"] = True
    except ClientError as exc:
        code = _error_code(exc)
        if code in {"403", "400", ""}:
            # HEAD responses have no body, so the real cause (bad key, bad secret, wrong region,
            # policy deny) is invisible. A one-key listing returns the S3 error code.
            try:
                client.list_objects_v2(Bucket=bucket, MaxKeys=1)
            except ClientError as detail_exc:
                detail_code = _error_code(detail_exc)
                if detail_code:
                    code = detail_code
            except BotoCoreError:
                pass
        error_type, message = _classify_client_error(code, bucket)
        out["s3_bucket_exists"] = False if error_type == "no_such_bucket" else out["s3_bucket_exists"]
        out["s3_error_type"] = error_type
        out["s3_message"] = message
        logger.info("%s", {"stage": "s3_probe_head_bucket", "bucket": bucket, "error_code": code})
        return out
    except BotoCoreError as exc:
        error_type, message, reachable = _classify_network_error(exc, use_ssl, endpoint_url)
        out["s3_endpoint_reachable"] = reachable
        out["s3_error_type"] = error_type
        out["s3_message"] = message
        logger.info("%s", {"stage": "s3_probe_head_bucket_network", "error_type": type(exc).__name__})
        return out

    out["s3_auth_ok"] = True

    keys: list[str] = []
    count = 0
    max_keys = max(1, min(int(preview_key_limit), 1000))
    try:
        resp = client.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=max_keys)
        for item in resp.get("Contents") or []:
            key = str(item.get("Key") or "")
            if not key or key.endswith("/"):
                continue
            count += 1
            if len(keys) < preview_key_limit:
                keys.append(key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code") or "")
        out["s3_auth_ok"] = False
        out["s3_error_type"] = "list_failed"
        out["s3_message"] = f"ListObjectsV2 failed: {code or type(exc).__name__}"
        logger.info("%s", {"stage": "s3_probe_list_failed", "bucket": bucket, "prefix": prefix, "error_code": code})
        return out
    except BotoCoreError as exc:
        out["s3_error_type"] = "list_network_error"
        out["s3_message"] = f"ListObjects network error: {type(exc).__name__}"
        logger.info("%s", {"stage": "s3_probe_list_network", "error_type": type(exc).__name__})
        return out

    out["s3_object_count_preview"] = count
    out["s3_sample_keys"] = keys
    out["s3_message"] = f"Listed up to {max_keys} keys under prefix {prefix!r}; preview shows first {len(keys)} keys."
    return out
