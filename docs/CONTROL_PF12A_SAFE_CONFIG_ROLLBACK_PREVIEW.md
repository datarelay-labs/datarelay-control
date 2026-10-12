# Control PF-12A — Read-only safe configuration rollback preview

**Status:** Product-native, source-only advisory preview. **NOT** a qualified
rollback path, actual backup, MFA user acceptance, or release.

**Foundation reference:** PF-12A shared
`datarelay-onprem-security==0.10.0.dev0` pinned in Control; shared
`ConfigRevision`, `diff_configurations`, `RollbackEvidence` and
`preview_config_rollback`. No copied Foundation policy engine.

## Existing Control authority reused

- `platform_config_versions` already records product-owned historical
  configuration snapshots for Streams, Routes, Mappings and Destinations.
- Existing `/api/v1/admin/config-versions` list/detail/compare and
  `apply-snapshot` endpoints are **unchanged** by this bounded addition.
- A new GET endpoint
  `/api/v1/admin/config-versions/{row_id}/safe-rollback-preview?expected_version=N&target=before`
  fetches the existing revision record and current live entity snapshot through
  the existing read-only DB dependency. No table or new runtime is introduced.
- Request identity is taken only from the server's already-resolved auth
  context. A JWT Administrator is a candidate authorized actor; MFA must
  actually have been verified. Anonymous development identity never qualifies.
  Existing RBAC policy and the older mutation endpoint are not changed.

## Strict non-secret projection

Only a fixed product-approved subset is sent to the Foundation library:

| Existing snapshot kind | Diff-only safe fields |
| --- | --- |
| `STREAM_CONFIG` | `enabled`, `polling_interval` |
| `ROUTE_CONFIG` | `enabled`, enumerated `failure_policy` |
| `DESTINATION_CONFIG` | `enabled` |
| `MAPPING_CONFIG` | Not yet supported; fail closed |

All arbitrary JSON (`config_json`, formatter, headers, routes, credential
references, tokens, URLs), freeform names and external event data are omitted
*before* constructing a `ConfigRevision`. Required scalar fields must be
present with exact types; malformed revisions fail closed. Deterministic
SHA256 fingerprints describe only this bounded projection, **not**
cryptographic ownership or a proven database snapshot.

The response includes a source version row ID, actual current and
caller-expected monotonic versions, sorted safe changes, fingerprints and
product-neutral blocker codes. It never returns an apply token or an action
that mutates a Stream, Route, Destination, checkpoint or credential.

## Rollback readiness / gating

Although Control already has an older `apply-snapshot` workflow, it has
**not** passed PF-12A's privileged atomic rollback and recovery acceptance.
The new preview therefore conservatively supplies
`product_rollback_supported=false`, `backup_verified=false`,
`rollback_path_verified=false`, `out_of_band_recovery=false`, and
`audit_ready=false`. Reversible paths are empty until product
classification and actual recovery evidence are approved.

`may_submit_to_product_authority` must therefore be **false**; this is
informational diff and blocker visibility, **not** readiness to invoke the
older mutation API. Existing role, delivery and operator state are preserved.

Remaining PF-12A completion: product-authoritative backup and rollback
evidence, authorized MFA operator and action/revision CAS validation, safe
preview-confirm-apply cycle, auditable actual read-back, isolated recovery
qualification, Browser BFS and two genuine-user E2E before release.

## Source validation

`tests/test_pf12a_config_safe_rollback_preview.py` covers strict
allowlisting, omitted secret-bearing JSON, deterministic sorted diffs,
stale version blocking, malformed/unsupported snapshots, legacy
anonymous-admin denial, and actual GET endpoint contract with mocked,
nonpersistent repositories. No real database, host operation, production
credential or rollback command is invoked.
