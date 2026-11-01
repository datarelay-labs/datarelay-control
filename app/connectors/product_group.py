"""Connector product_group inference (M31.1 backfill + optional create default)."""

from __future__ import annotations

PRODUCT_GROUP_MAX_LENGTH = 128  # connectors.product_group is VARCHAR(128)

PRODUCT_ALIASES: list[tuple[str, str]] = [
    ("crowdstrike", "CrowdStrike"),
    ("falcon", "CrowdStrike"),
    ("okta", "Okta"),
    ("microsoft 365", "Microsoft 365"),
    ("office365", "Microsoft 365"),
    ("m365", "Microsoft 365"),
    ("azure", "Microsoft Azure"),
    ("aws", "Amazon Web Services"),
    ("amazon s3", "Amazon S3"),
    ("splunk", "Splunk"),
    ("sentinel", "Microsoft Sentinel"),
    ("palo alto", "Palo Alto Networks"),
    ("google", "Google Cloud"),
    ("gcp", "Google Cloud"),
    ("datadog", "Datadog"),
    ("elastic", "Elastic"),
    ("proofpoint", "Proofpoint"),
    ("zscaler", "Zscaler"),
    ("carbon black", "VMware Carbon Black"),
]


def infer_product_group_from_connector_name(name: str | None) -> str | None:
    """Mirror frontend ``resolveSourceProductLabel`` name heuristic (no API metadata)."""
    raw = (name or "").strip()
    if not raw:
        return None
    lower = raw.lower()
    for needle, label in PRODUCT_ALIASES:
        if needle in lower:
            return label
    return raw[:PRODUCT_GROUP_MAX_LENGTH]
