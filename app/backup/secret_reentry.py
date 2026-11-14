"""Describe which secrets an import bundle cannot carry (masked in the export) and must be re-entered."""

from __future__ import annotations

from typing import Any

from app.security.secrets import find_masked_secret_paths

_SOURCE_LABELS = {
    "WEBHOOK_RECEIVER": "webhook receiver",
    "WEBHOOK": "webhook receiver",
    "HTTP_API_POLLING": "HTTP API connector",
    "S3_OBJECT_POLLING": "S3-compatible connector",
    "DATABASE_QUERY": "database connector",
    "REMOTE_FILE_POLLING": "SFTP / remote file connector",
}

# Stored key -> label of the connector form field where the user re-enters it.
_FIELD_LABELS = {
    "shared_secret": "Shared secret",
    "bearer_token": "Bearer token",
    "basic_password": "Password",
    "api_key_value": "API key value",
    "api_key": "API key",
    "oauth2_client_secret": "OAuth2 client secret",
    "login_password": "Login password",
    "refresh_token": "Refresh token",
    "secret_key": "Secret key",
    "password": "Password",
    "private_key": "Private key",
    "private_key_passphrase": "Private key passphrase",
    "token_body": "Token body",
    "login_body_raw": "Login body",
    "preflight_body_raw": "Preflight body",
    "request_body": "Request body",
    "payload_preview": "Sample payload",
}


def _field_label(path: str) -> str:
    leaf = path.split(".")[-1]
    return _FIELD_LABELS.get(leaf, path)


def collect_secret_reentry(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    """One entry per connector/destination whose secrets are masked in ``bundle``.

    Each entry: ``entity_type``, ``export_id``, ``name``, ``source_type``, ``fields`` (labels),
    ``blocks_operation`` and a user-facing ``message`` that names the connector and the fields.
    """

    connectors = {
        int(c["id"]): c for c in (bundle.get("connectors") or []) if isinstance(c, dict) and c.get("id") is not None
    }
    items: list[dict[str, Any]] = []
    for s in bundle.get("sources") or []:
        if not isinstance(s, dict):
            continue
        paths = [
            *[f"{p}" for p in find_masked_secret_paths(s.get("auth_json") or {})],
            *[f"{p}" for p in find_masked_secret_paths(s.get("config_json") or {})],
        ]
        if not paths:
            continue
        stype = str(s.get("source_type") or "").strip().upper()
        cid = s.get("connector_id")
        cname = str((connectors.get(int(cid)) or {}).get("name") or f"connector {cid}") if cid is not None else "connector"
        labels = list(dict.fromkeys(_field_label(p) for p in paths))
        consequence = (
            "Until then the receiver rejects every request with 401."
            if stype in {"WEBHOOK_RECEIVER", "WEBHOOK"}
            else "Until then this connector cannot authenticate to its source."
        )
        kind = _SOURCE_LABELS.get(stype, "connector")
        items.append(
            {
                "entity_type": "connector",
                "export_id": int(cid) if cid is not None else None,
                "export_source_id": s.get("id"),
                "name": cname,
                "source_type": stype,
                "fields": labels,
                "blocks_operation": True,
                "message": (
                    f"{cname!r} ({kind}): secrets are never stored in exports. After import, open the connector "
                    f"and re-enter: {', '.join(labels)}. {consequence}"
                ),
            }
        )
    for d in bundle.get("destinations") or []:
        if not isinstance(d, dict):
            continue
        paths = find_masked_secret_paths(d.get("config_json") or {})
        if not paths:
            continue
        labels = list(dict.fromkeys(_field_label(p) for p in paths))
        name = str(d.get("name") or f"destination {d.get('id')}")
        items.append(
            {
                "entity_type": "destination",
                "export_id": int(d["id"]) if d.get("id") is not None else None,
                "export_source_id": None,
                "name": name,
                "source_type": None,
                "fields": labels,
                "blocks_operation": False,
                "message": (
                    f"Destination {name!r}: secret header/credential values are masked in exports. "
                    f"After import, open the destination and re-enter: {', '.join(labels)}."
                ),
            }
        )
    return items
