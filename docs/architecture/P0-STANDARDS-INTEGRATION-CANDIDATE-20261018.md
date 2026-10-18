# P0 Standards Integration Candidate — 2026-10-18

**Status: candidate, not release-authoritative.** DataRelay Control source HEAD `397050ea44fe2c3b971ba113671bfaca5073e8c0` from UX PR #414; standards evidence Issue #442. Current product integration branch is `main-v2`, while GitHub also has an older `main` branch. Do not mutate or substitute the ongoing Issue #413 FUE assets.

## Changes
- **JSONPath/Protection:** Preserve first-match Basic Mapping and unmapped source fields; disambiguate bracket-quoted literal keys from nested objects in the Mapping, observed-schema, Protection and drift-path modules.
- **Schema Observation:** Add accurate per-event field presence using `occurrence_count` and `counting_v1` metadata without converting legacy inflated `observation_count`; preserve schema baselines and serialized extensions. Serialize writes using Stream-parent then observed-row PostgreSQL locking.
- **Syslog:** Keep Legacy newline-delimited output as the default. Optional `syslog_wire_mode=rfc5425` sends RFC 5424-style JSON/BOM over octet-counted TLS; disallow conflicting Legacy prefix overrides; escape control characters in derived Legacy Syslog Prefix only.

## Known limits and acceptance risks
- Historical `$.a.b` could mean literal `"a.b"` or nested `a.b`; saved paths, Privacy rules and Identity Vault keys cannot be auto-migrated without evidence.
- `jsonpath-ng 1.8.0` is not fully RFC 9535-compliant. Two strict XFAIL tests remain (negative out-of-bounds index and escaped newline member).
- Mandatory Protection rule misses, target-specific route payload safety and full persisted field-path migrations require more product-level evidence.
- Existing StreamRunner holds same-Stream thread and host locks. Parent-row database locking is extra protection but needs real Stream/DB integration and lock-order review.
- RFC 5424 subset uses NIL structured data only. Config persistence/UI, vendor TLS collector and checkpoint/retry E2E are still required.
- OCSF 1.9.0/ECS 9.5.0 profile validators are research-only and are **not** complete schema or product integrations.

## Selected verification
213 PASS / 2 strict XFAIL in focused backend suites; 35 PASS / 2 SKIP in additional Mapping/Protection/TLS tests. Prior disposable PostgreSQL 16 and local TLS 1.3 research runs were independent and do not replace exact-candidate public Browser and Full User E2E.

Do not merge to `main-v2` or the older `main` until the candidate's actual affected tests, CI review, Browser and Full User E2E release gates and applicable owner acceptance pass. Do not deploy Production as part of this scope.
