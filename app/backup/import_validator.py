"""Validate import bundles before apply (schema, references, supported types)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from collections import defaultdict
from sqlalchemy.orm import Session

from app.backup.export_builder import canonical_bundle_json
from app.backup.export_validation import assert_bundle_json_roundtrip
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.sources.adapters.registry import SourceAdapterRegistry


def _bundle_identity_for_token(bundle: dict[str, Any]) -> dict[str, Any]:
    """Omit volatile export envelope fields so preview/apply tokens stay stable."""

    omit = frozenset({"export_integrity", "exported_at"})
    return {k: v for k, v in bundle.items() if k not in omit}


def preview_token_for(bundle: dict[str, Any], mode: str) -> str:
    raw = f"{canonical_bundle_json(_bundle_identity_for_token(bundle))}|{mode}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _supported_source_types() -> frozenset[str]:
    reg = SourceAdapterRegistry()
    return frozenset(str(k).upper() for k in reg._by_type.keys())  # noqa: SLF001


def _destination_supported(destination_type: str) -> bool:
    key = str(destination_type or "").strip().upper()
    if key == "WEBHOOK_POST":
        return True
    if key.startswith("SYSLOG"):
        return True
    return False


def _try_dest_adapter(destination_type: str) -> bool:
    try:
        DestinationAdapterRegistry().get(destination_type)
        return True
    except Exception:
        return _destination_supported(destination_type)


_ROUTE_FAILURE_POLICIES = frozenset(
    {"LOG_AND_CONTINUE", "PAUSE_STREAM_ON_FAILURE", "DISABLE_ROUTE_ON_FAILURE", "RETRY_AND_BACKOFF"}
)


@dataclass
class ValidationOutcome:
    ok: bool
    export_kind: str | None = None
    counts: dict[str, int] = field(default_factory=dict)
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)
    unsupported: list[str] = field(default_factory=list)
    findings: list[dict[str, Any]] = field(default_factory=list)
    classification_summary: dict[str, int] = field(default_factory=dict)


def validate_import_bundle(db: Session, bundle: dict[str, Any], *, mode: str) -> ValidationOutcome:
    conflicts: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    unsupported: list[str] = []
    findings: list[dict[str, Any]] = []

    if mode == "full_restore":
        return ValidationOutcome(
            ok=False,
            conflicts=[
                {
                    "code": "FULL_RESTORE_RETIRED",
                    "message": (
                        "mode=full_restore is retired. JSON import supports additive and clone only; "
                        "use PostgreSQL backup/restore for disaster recovery."
                    ),
                }
            ],
        )
    if mode not in ("additive", "clone"):
        return ValidationOutcome(
            ok=False,
            conflicts=[
                {
                    "code": "IMPORT_MODE_UNSUPPORTED",
                    "message": f"Unsupported import mode {mode!r}. Allowed: additive, clone.",
                }
            ],
        )

    if not isinstance(bundle, dict):
        return ValidationOutcome(ok=False, conflicts=[{"code": "INVALID_BUNDLE", "message": "Bundle must be a JSON object."}])

    version = bundle.get("version")
    if version not in (1, 2):
        conflicts.append(
            {
                "code": "UNSUPPORTED_VERSION",
                "message": f"Unsupported export version: {version!r}. Expected 1 or 2.",
            }
        )
        return ValidationOutcome(ok=False, conflicts=conflicts)

    export_kind = bundle.get("export_kind")
    if export_kind is not None and export_kind not in ("workspace", "connector", "stream"):
        warnings.append({"code": "UNKNOWN_EXPORT_KIND", "message": f"Unknown export_kind {export_kind!r}; proceeding as workspace-style import."})

    connectors = bundle.get("connectors") or []
    sources = bundle.get("sources") or []
    streams = bundle.get("streams") or []
    mappings = bundle.get("mappings") or []
    enrichments = bundle.get("enrichments") or []
    destinations = bundle.get("destinations") or []
    routes = bundle.get("routes") or []
    checkpoints = bundle.get("checkpoints") or []

    if not isinstance(connectors, list) or not connectors:
        conflicts.append({"code": "MISSING_CONNECTORS", "message": "Import bundle must include a non-empty connectors array."})
    if conflicts:
        return ValidationOutcome(ok=False, conflicts=conflicts)

    for issue in assert_bundle_json_roundtrip(bundle):
        conflicts.append({"code": "BUNDLE_JSON_INVALID", "message": issue})

    for c in connectors:
        if not isinstance(c, dict):
            conflicts.append({"code": "INVALID_CONNECTOR_ROW", "message": "Invalid connector entry (expected object)."})
            continue
        if c.get("id") is None:
            conflicts.append(
                {
                    "code": "CONNECTOR_MISSING_EXPORT_ID",
                    "message": f"Connector {c.get('name')!r} is missing export id; cannot remap graph.",
                    "details": {"name": c.get("name")},
                }
            )

    conn_name_to_ids: dict[str, list[int]] = defaultdict(list)
    for c in connectors:
        if isinstance(c, dict) and c.get("id") is not None:
            n = str(c.get("name") or "").strip()
            if n:
                conn_name_to_ids[n].append(int(c["id"]))
    for name, cids in conn_name_to_ids.items():
        if len(cids) > 1:
            msg = f"Bundle contains {len(cids)} connectors named {name!r}; resolve duplicates before import."
            conflicts.append(
                {
                    "code": "DUPLICATE_CONNECTOR_NAME_IN_BUNDLE",
                    "message": msg,
                    "details": {"name": name, "export_connector_ids": cids},
                }
            )
            findings.append(
                {
                    "classification": "blocked",
                    "entity_type": "connector",
                    "code": "DUPLICATE_CONNECTOR_NAME_IN_BUNDLE",
                    "message": msg,
                    "details": {"name": name, "export_connector_ids": cids},
                }
            )

    conn_ids_export = {int(c["id"]) for c in connectors if isinstance(c, dict) and c.get("id") is not None}
    for s in sources:
        if not isinstance(s, dict):
            conflicts.append({"code": "INVALID_SOURCE_ROW", "message": "Invalid source entry (expected object)."})
            continue
        cid = s.get("connector_id")
        if cid is None or int(cid) not in conn_ids_export:
            conflicts.append(
                {
                    "code": "SOURCE_CONNECTOR_MISMATCH",
                    "message": f"Source {s.get('id')} references connector_id {cid} not present in bundle.",
                }
            )

    stream_ids_export: set[int] = set()
    for st in streams:
        if not isinstance(st, dict):
            conflicts.append({"code": "INVALID_STREAM_ROW", "message": "Invalid stream entry (expected object)."})
            continue
        if st.get("id") is None:
            conflicts.append(
                {
                    "code": "STREAM_MISSING_EXPORT_ID",
                    "message": f"Stream {st.get('name')!r} is missing export id; cannot remap graph.",
                    "details": {"name": st.get("name")},
                }
            )
            continue
        sid = int(st["id"])
        stream_ids_export.add(sid)
        if int(st.get("connector_id", -1)) not in conn_ids_export:
            conflicts.append(
                {
                    "code": "STREAM_CONNECTOR_MISMATCH",
                    "message": f"Stream {st.get('id')} references missing connector_id {st.get('connector_id')}.",
                }
            )
        if int(st.get("source_id", -1)) not in {int(x["id"]) for x in sources if isinstance(x, dict) and x.get("id") is not None}:
            conflicts.append(
                {
                    "code": "STREAM_SOURCE_MISMATCH",
                    "message": f"Stream {st.get('id')} references missing source_id {st.get('source_id')}.",
                }
            )

    stream_sig: dict[tuple[int, str], list[int]] = defaultdict(list)
    for st in streams:
        if not isinstance(st, dict) or st.get("id") is None:
            continue
        cid_e = int(st.get("connector_id", -1))
        nm = str(st.get("name") or "").strip()
        if nm:
            stream_sig[(cid_e, nm)].append(int(st["id"]))
    for (cid_e, nm), sids in stream_sig.items():
        if len(sids) > 1:
            msg = (
                f"Bundle contains duplicate stream names {nm!r} under export connector_id {cid_e} "
                f"(stream ids {sids})."
            )
            conflicts.append(
                {
                    "code": "DUPLICATE_STREAM_NAME_IN_BUNDLE",
                    "message": msg,
                    "details": {"export_connector_id": cid_e, "name": nm, "export_stream_ids": sids},
                }
            )
            findings.append(
                {
                    "classification": "blocked",
                    "entity_type": "stream",
                    "code": "DUPLICATE_STREAM_NAME_IN_BUNDLE",
                    "message": msg,
                    "details": {"export_connector_id": cid_e, "name": nm, "export_stream_ids": sids},
                }
            )

    src_types = _supported_source_types()
    for s in sources:
        if not isinstance(s, dict):
            continue
        stype = str(s.get("source_type") or "").strip().upper()
        if stype not in src_types:
            unsupported.append(f"Unsupported source_type {stype!r} on source id={s.get('id')}")
            conflicts.append({"code": "UNSUPPORTED_SOURCE_TYPE", "message": f"Unsupported source_type {stype!r}."})

    for d in destinations:
        if not isinstance(d, dict):
            conflicts.append({"code": "INVALID_DESTINATION_ROW", "message": "Invalid destination entry."})
            continue
        if d.get("id") is None:
            conflicts.append(
                {
                    "code": "DESTINATION_MISSING_EXPORT_ID",
                    "message": f"Destination {d.get('name')!r} is missing export id; cannot remap routes.",
                    "details": {"name": d.get("name")},
                }
            )
            continue
        dtype = str(d.get("destination_type") or "")
        if not _try_dest_adapter(dtype):
            unsupported.append(f"Unsupported destination_type {dtype!r} on destination id={d.get('id')}")
            conflicts.append({"code": "UNSUPPORTED_DESTINATION_TYPE", "message": f"Unsupported destination_type {dtype!r}."})

    bundle_dest_ids = {int(d["id"]) for d in destinations if isinstance(d, dict) and d.get("id") is not None}

    for r in routes:
        if not isinstance(r, dict):
            conflicts.append({"code": "INVALID_ROUTE_ROW", "message": "Invalid route entry."})
            continue
        fp = str(r.get("failure_policy") or "LOG_AND_CONTINUE").strip()
        if fp not in _ROUTE_FAILURE_POLICIES:
            conflicts.append(
                {
                    "code": "INVALID_ROUTE_FAILURE_POLICY",
                    "message": f"Route {r.get('id')} has unsupported failure_policy {fp!r}.",
                    "details": {"route_export_id": r.get("id"), "failure_policy": fp},
                }
            )
        if int(r.get("stream_id", -1)) not in stream_ids_export:
            conflicts.append(
                {
                    "code": "ROUTE_STREAM_MISMATCH",
                    "message": f"Route {r.get('id')} references stream_id {r.get('stream_id')} missing from bundle.",
                }
            )
        did = int(r.get("destination_id", -1))
        if did in bundle_dest_ids:
            continue
        if db.get(Destination, did) is None:
            conflicts.append(
                {
                    "code": "MISSING_DESTINATION",
                    "message": (
                        f"Route {r.get('id')} references destination_id={did} which is not in the bundle "
                        "and does not exist in this database. Include destinations in the export or create the destination first."
                    ),
                    "details": {"destination_id": did, "route_export_id": r.get("id")},
                }
            )

    for m in mappings:
        if not isinstance(m, dict):
            conflicts.append({"code": "INVALID_MAPPING_ROW", "message": "Invalid mapping entry."})
            continue
        if int(m.get("stream_id", -1)) not in stream_ids_export:
            conflicts.append(
                {
                    "code": "MAPPING_STREAM_MISMATCH",
                    "message": f"Mapping {m.get('id')} references stream_id {m.get('stream_id')} missing from bundle.",
                }
            )

    for e in enrichments:
        if not isinstance(e, dict):
            conflicts.append({"code": "INVALID_ENRICHMENT_ROW", "message": "Invalid enrichment entry."})
            continue
        if int(e.get("stream_id", -1)) not in stream_ids_export:
            conflicts.append(
                {
                    "code": "ENRICHMENT_STREAM_MISMATCH",
                    "message": f"Enrichment {e.get('id')} references stream_id {e.get('stream_id')} missing from bundle.",
                }
            )

    for c in checkpoints:
        if not isinstance(c, dict):
            conflicts.append({"code": "INVALID_CHECKPOINT_ROW", "message": "Invalid checkpoint entry."})
            continue
        if int(c.get("stream_id", -1)) not in stream_ids_export:
            conflicts.append(
                {
                    "code": "CHECKPOINT_STREAM_MISMATCH",
                    "message": f"Checkpoint {c.get('id')} references stream_id {c.get('stream_id')} missing from bundle.",
                }
            )

    # Route linkage: routes require mapping rows for the same stream when the bundle includes streams.
    streams_with_mapping = {int(m.get("stream_id")) for m in mappings if isinstance(m, dict) and m.get("stream_id") is not None}
    streams_with_routes = {int(r.get("stream_id")) for r in routes if isinstance(r, dict) and r.get("stream_id") is not None}
    if routes and streams and not mappings:
        conflicts.append(
            {
                "code": "ROUTES_WITHOUT_MAPPINGS",
                "message": "Bundle includes routes but no mapping rows; streams with routes require mapping configuration.",
            }
        )
    elif routes and streams:
        for sid in streams_with_routes:
            if sid in stream_ids_export and sid not in streams_with_mapping:
                conflicts.append(
                    {
                        "code": "ROUTE_WITHOUT_MAPPING",
                        "message": (
                            f"Route references stream_id {sid} but no mapping row exists for that stream in the bundle. "
                            "Streams with routes require mapping configuration."
                        ),
                        "details": {"stream_id": sid},
                    }
                )

    # Connector / destination name collisions with existing DB rows (additive/clone create new PKs).
    existing_connector_names = {str(c.name) for c in db.query(Connector).all()}
    for c in connectors:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()
        if name and name in existing_connector_names:
            msg = f"A connector named {name!r} already exists; import will create another connector with the same display name."
            findings.append(
                {
                    "classification": "overwrite_candidate",
                    "entity_type": "connector",
                    "code": "CONNECTOR_NAME_EXISTS",
                    "message": msg,
                    "details": {"name": name, "export_connector_id": c.get("id")},
                }
            )

    existing_dest_names = {str(d.name) for d in db.query(Destination).all()}
    for d in destinations:
        if not isinstance(d, dict):
            continue
        dn = str(d.get("name") or "").strip()
        if dn and dn in existing_dest_names:
            msg = f"A destination named {dn!r} already exists; import may create a second destination with the same name."
            findings.append(
                {
                    "classification": "overwrite_candidate",
                    "entity_type": "destination",
                    "code": "DESTINATION_NAME_EXISTS",
                    "message": msg,
                    "details": {"name": dn, "export_destination_id": d.get("id")},
                }
            )

    auth_masked = any(
        isinstance(s, dict) and json.dumps(s.get("auth_json") or {}).find("********") >= 0 for s in sources if isinstance(s, dict)
    )
    if auth_masked:
        warnings.append(
            {
                "code": "MASKED_AUTH_IN_BUNDLE",
                "message": "Auth fields appear masked; re-enter credentials on the new connector/source after import.",
            }
        )

    dest_masked = any(
        isinstance(d, dict) and json.dumps(d.get("config_json") or {}).find("********") >= 0 for d in destinations if isinstance(d, dict)
    )
    if dest_masked:
        warnings.append(
            {
                "code": "MASKED_DESTINATION_CONFIG",
                "message": "Destination config may contain masked secrets; verify delivery settings after import.",
            }
        )

    tmpl = bundle.get("template_metadata") or {}
    if isinstance(tmpl, dict) and tmpl.get("template_id"):
        warnings.append(
            {
                "code": "TEMPLATE_METADATA_PRESENT",
                "message": "Bundle carries template metadata; verify template compatibility in the target environment.",
            }
        )

    counts = {
        "connectors": len(connectors),
        "sources": len(sources),
        "streams": len(streams),
        "mappings": len(mappings),
        "enrichments": len(enrichments),
        "destinations": len(destinations),
        "routes": len(routes),
        "checkpoints": len(checkpoints),
    }

    ok = not conflicts
    overwrite_n = len([f for f in findings if f.get("classification") == "overwrite_candidate"])
    classification_summary = {
        "safe_create": 1 if (ok and not findings) else 0,
        "overwrite_candidate": overwrite_n,
        "blocked": 0 if ok else len(conflicts),
    }
    return ValidationOutcome(
        ok=ok,
        export_kind=str(export_kind) if export_kind else None,
        counts=counts,
        conflicts=conflicts,
        warnings=warnings,
        unsupported=unsupported,
        findings=findings,
        classification_summary=classification_summary,
    )
