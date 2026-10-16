"""S3 / MinIO connectivity probe for UI and connector-auth test (no secrets in return values)."""

from __future__ import annotations

import logging
from typing import Any

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger(__name__)


def _get(data: Any, key: str, default: Any = None) -> Any:
    if isinstance(data, dict):
        return data.get(key, default)
    return getattr(data, key, default)


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
        code = str(exc.response.get("Error", {}).get("Code") or "")
        if code in {"404", "NoSuchBucket", "NotFound"}:
            out["s3_bucket_exists"] = False
            out["s3_error_type"] = "no_such_bucket"
            out["s3_message"] = f"Bucket not found or no access: {bucket!r}"
        elif code in {"403", "AccessDenied"}:
            out["s3_error_type"] = "access_denied"
            out["s3_message"] = "Access denied listing bucket (check IAM: s3:ListBucket)"
        else:
            out["s3_error_type"] = "head_bucket_failed"
            out["s3_message"] = f"HeadBucket failed: {code or type(exc).__name__}"
        logger.info("%s", {"stage": "s3_probe_head_bucket", "bucket": bucket, "error_code": code})
        return out
    except BotoCoreError as exc:
        out["s3_endpoint_reachable"] = False
        out["s3_error_type"] = "network_error"
        out["s3_message"] = f"Connection error: {type(exc).__name__}"
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
