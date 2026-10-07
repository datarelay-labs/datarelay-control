# DataRelay Control — Canonical Full User E2E Scenarios

Status: canonical qualification specification
Scope authority: current Product Charter and Master WBS, Phase A-D only
Execution model: browser-first user journey plus runtime/receiver evidence where browser observation alone cannot prove delivery semantics.

## 1. Purpose and completion rule

This specification defines what **Full User E2E PASS** means for DataRelay Control. A release is not qualified by isolated API/unit tests alone: supported user-visible workflows must be exercised from the browser, persisted, executed by the runtime when applicable, and verified at the externally observable outcome.

A scenario is `PASS` only when every mandatory checkpoint in that scenario passes. `SKIP` is not PASS. An item may be `NOT_APPLICABLE` only when this document explicitly classifies it that way or current product authority removes it from scope.

Every execution records: exact git HEAD, build/image identity, environment, browser, role/persona, UTC start/end timestamps, fixture identifiers, created object IDs, screenshots at user-visible checkpoints, API/runtime correlation IDs when available, receiver evidence for deliveries, cleanup result, and final PASS/FAIL/NOT_APPLICABLE status.

## 2. Product-scope gate

### 2.1 Included

The qualification surface is DataRelay Control Phase A-D: authentication/RBAC, platform administration, supported connectors and destinations, Stream Wizard and lifecycle, Route Processing, Transform/Mapping/Enrichment, Governance, runtime delivery/checkpoint/recovery, observability/logs, backup/import, and release-operational recovery.

### 2.2 Explicitly excluded

`AI Gateway`, `AI Proxy`, `AI Provider`, AI Stream, AI policy/audit, and all Phase E material are **not DataRelay Control product scope**. Phase F Enterprise Edition is also outside current Control scope. These items MUST NOT contribute to scenario totals, coverage percentage, release readiness, blockers, or PASS/FAIL denominators.

Historical AI implementation/specification files may remain as historical reference, but their existence is not evidence of a supported Control capability. Any generated capability inventory that contains those historical AI rows must classify/exclude them before computing current Control coverage.

### 2.3 Not claimed by current authority

The following are not mandatory release gates unless a current authoritative product/release document later makes the claim:

- cross-browser parity beyond the release-selected qualification browser;
- DataRelay Link or DataRelay Grant product integration;
- MySQL/MariaDB as Database Query product types;
- Phase E/F functionality.

These are recorded as `NOT_APPLICABLE_NOT_CLAIMED`, not as PASS.

## 3. Qualification environment and personas

Use the production-like packaged deployment path selected by the release candidate. Do not substitute frontend dev-server behavior for packaged-product evidence.

Required personas:

- **Administrator** — platform configuration, users, security, retention, recovery and all operator capabilities.
- **Operator** — day-to-day data-flow operation; must be denied administrator-only mutations.
- **Viewer/read-only persona**, when exposed by the current role model — observation only; mutations must be denied.

Required external fixtures are real or protocol-faithful receivers/sources for the scenario under test. Mock-only evidence is insufficient for the final delivery checkpoint when a real protocol receiver is available in the repository E2E stack.

## 4. Canonical scenario matrix

| ID | Priority | User journey | Mandatory proof |
| --- | --- | --- | --- |
| U01 | P0 | First login and session lifecycle | login succeeds; identity/role visible; refresh survives normal navigation; logout invalidates session |
| U02 | P0 | Administrator vs Operator authorization | admin mutation succeeds; same admin-only mutation is hidden/disabled in UI and rejected server-side for Operator |
| U03 | P0 | HTTP API connector → Stream → webhook destination → live delivery | connection/auth test; sample; mapping; destination test; deploy/start; receiver gets expected event; runtime/log evidence correlates |
| U04 | P0 | HTTP auth variants | no-auth, basic, bearer, API-key paths complete connection/sample path; secrets are not exposed in normal UI/log evidence |
| U05 | P0 | Webhook Receiver → Stream → destination | receiver endpoint accepts event; event traverses active Stream/Route; destination receives expected payload |
| U06 | P0 | Destination protocol matrix | webhook POST plus SYSLOG UDP/TCP/TLS; test delivery and live delivery; TLS path verifies configured trust/client material as applicable |
| U07 | P0 | Checkpoint correctness | successful delivery advances checkpoint; failed delivery does not falsely advance; retry/recovery advances only after success |
| U08 | P0 | Stream run control and persistence | create/deploy, stop, start, edit, reload/read-back; state and effective configuration remain coherent |
| U09 | P0 | Route Processing effective truth | Wizard route settings persist; effective mapping/enrichment/protection/policy match saved configuration; current supported release path is Route-ON only |
| U10 | P0 | Governance enforcement | policy/protection action is visible in preview/effective view and enforced at runtime; continue/quarantine/block behavior matches configuration |
| U11 | P1 | S3 source lifecycle | create/auth/sample; incremental/checkpoint behavior; live delivery; restart/read-back preserves state, subject to current source-scope authority |
| U12 | P1 | PostgreSQL Database Query lifecycle | create/auth/query sample; checkpoint/incremental behavior; live delivery; restart/read-back |
| U13 | P1 | Remote File/SFTP lifecycle | create/auth/probe/sample; file watermark/checkpoint; live delivery; restart/read-back, subject to current source-scope authority |
| U14 | P1 | Mapping and Transform | field mapping plus full-event JSONata/regex and type/timestamp conversion; preview equals runtime-effective output for selected fixture |
| U15 | P1 | Enrichment | supported enrichment rules save/read-back and change the delivered event as previewed |
| U16 | P1 | Deduplication | duplicate fixture is skipped according to configuration; counters/logs expose the outcome; non-duplicate event delivers |
| U17 | P1 | Incremental fetch | configured cursor/checkpoint is used on subsequent run; no unintended re-read; reset is explicit and observable |
| U18 | P1 | Multi-route delivery and route health | one Stream fans out to configured routes/destinations; each receiver gets correct output; route health/metrics reflect outcomes |
| U19 | P1 | Dynamic/failover routing | routing condition selects expected route; induced primary failure activates configured failover behavior; recovery is observable |
| U20 | P1 | Stream edit after deployment | edit supported configuration; stale/effective values are not silently retained; new runtime behavior matches saved revision |
| U21 | P1 | Timezone UX | platform IANA timezone save/read-back; user override and empty-override fallback; displayed timestamps change while stored/runtime truth remains UTC |
| U22 | P1 | Logs and traceability | user finds delivery/runtime event in Logs; stream/run/log trace connects source → processing → route → destination outcome |
| U23 | P1 | Dashboard/operations consistency | dashboard, Stream detail, Route/Destination health and operational snapshot describe the same induced healthy/failing condition |
| U24 | P1 | Config-version evidence and rollback | mutate eligible config; version/audit evidence appears; compare revisions; apply snapshot; effective state returns to selected snapshot |
| U25 | P1 | Optimistic-concurrency stale write | two sessions edit same protected object; first save succeeds; second stale save receives conflict and cannot silently overwrite newer state |
| U26 | P2 | Quarantine lifecycle | event is quarantined by configured behavior; appears in Quarantine Center; release/discard action is authorized, audited and reflected in runtime state |
| U27 | P2 | Replay lifecycle | failed/eligible event appears in Replay Center; replay action produces a new observable delivery/result without corrupting checkpoint semantics |
| U28 | P2 | Schema drift / review | changed schema is detected; configured review/protection behavior is surfaced and enforced; operator can investigate from governance/runtime UI |
| U29 | P2 | Sensitive-data protection | configured mask/tokenize/hash/drop behavior is previewed and runtime output proves the same protection action |
| U30 | P2 | Governance approval workflow | request → pending review → authorized approve/reject → audit trail; unauthorized persona cannot approve; context remains intact across navigation |
| U31 | P2 | Governance notifications/violations | induced governed event produces the expected violation/action/notification surface and navigable investigation context |
| U32 | P2 | Backup/export → preview import → apply | export workspace/config; preview import shows intended change; apply restores/materializes expected objects without secret leakage |
| U33 | P2 | User/account lifecycle | admin creates/changes/disables/deletes eligible user; password/profile flow works; RBAC takes effect without privilege residue |
| U34 | P2 | HTTPS/network settings safeguards | validation rejects invalid/duplicate/reserved ports; authorized save/apply path gives reconnect guidance and service returns on intended listener |
| U35 | P2 | Retention and cleanup | dry-run reports candidate cleanup; authorized run respects policy; retained operational data remains available; action is observable/audited |
| U36 | P2 | Support bundle / maintenance health | maintenance health loads; support bundle can be produced by authorized user and does not expose plaintext secrets |
| U37 | P2 | Fault recovery matrix | HTTP 401/403/429/5xx, connector TLS failure, DB/source disconnect, destination outage; UI/runtime expose failure and recovery without false success/checkpoint advance |
| U38 | P2 | Delete dependency and destructive safeguards | deleting in-use connector/source/destination/stream is blocked or explicitly mediated; successful deletion leaves no misleading active route/runtime state |
| U39 | P2 | Refresh/restart persistence | after browser refresh and service restart, supported persisted objects/config remain; runtime resumes according to saved enabled/run state and checkpoint truth |
| U40 | P2 | Upgrade and rollback operational journey | pre-upgrade backup → packaged upgrade → health/smoke/data-flow verification; rollback/restore procedure returns service and data to documented safe state |
| U41 | P3 | Accessibility keyboard journey | login, primary navigation, dialogs and destructive confirmation are keyboard-operable with visible focus and usable labels on critical path |
| U42 | P3 | Large-volume/soak qualification | execute the release-defined workload profile; no correctness loss, uncontrolled queue growth, crash loop or silent delivery loss; collect latency/throughput/resource evidence |

## 5. Detailed P0 acceptance flows

### U03 — HTTP API to webhook live delivery

1. Administrator signs in through the packaged UI.
2. Create an HTTP API connector using the current Wizard. Use a deterministic fixture endpoint.
3. Run connection/auth validation and obtain sample data.
4. Select the intended record path/checkpoint candidate and complete mapping.
5. Create or select a webhook destination; run destination test and verify the receiver sees the test request.
6. Complete Route Processing with the release-supported Route-ON behavior and deploy the Stream.
7. Start/run the Stream from the UI.
8. Verify the receiver got the expected transformed event, not merely a 2xx API response from Control.
9. Verify Stream status, route/destination health, delivery log and trace identify the same run/outcome.
10. Refresh the browser and reopen the Stream. Saved configuration and runtime state must read back coherently.
11. Stop the Stream and verify no unintended new polling/delivery occurs.

Failure at any connection/sample/deploy/runtime/receiver/read-back checkpoint is scenario FAIL.

### U07 — Checkpoint correctness

1. Run a checkpoint-capable source through a healthy destination and record checkpoint before/after.
2. Prove the receiver accepted the event before accepting checkpoint advancement as valid.
3. Make the destination fail deterministically and introduce a new source item.
4. Run again. The failed item must not be represented as safely delivered by an advanced checkpoint.
5. Restore the destination and retry/recover through the supported user flow.
6. Verify exactly the intended item is delivered and checkpoint then advances.
7. Verify checkpoint history/trace and delivery logs agree.

### U09 — Route Processing effective truth

1. In the Wizard configure route-specific mapping/enrichment/protection/policy supported by the current release.
2. Save/deploy and reload the Stream/Route UI.
3. Verify persisted settings equal the values selected in the Wizard.
4. Verify effective runtime endpoints/UI report the same configuration.
5. Deliver a fixture that makes each configured operation observable at the receiver.
6. Compare preview/effective output with the delivered output.
7. No Route-OFF scenario may be substituted for this supported-release path.

### U10 — Governance enforcement

1. Configure a deterministic rule/action on a Stream/Route using an event fixture that will trigger it.
2. Preview/simulate where the UI supports it and record expected action.
3. Deploy/run the Stream.
4. Verify the runtime outcome: delivered with protection, quarantined, or blocked exactly as configured.
5. Verify Governance/Stream/Logs surfaces show consistent reason/context.
6. Verify an unauthorized persona cannot change the governing policy/action.

## 6. Cross-cutting negative and recovery rules

Every mutable workflow above must include at least one validation/authorization failure appropriate to that surface. The user must receive actionable feedback; the system must not silently accept invalid configuration.

For runtime scenarios, a green UI state is insufficient. Where a receiver exists, receiver evidence is mandatory. Where an action is destructive or privileged, audit evidence and RBAC enforcement are mandatory.

For fault scenarios, recovery must be tested after the fault is removed. PASS requires both correct failure semantics and return to a healthy observable state.

## 7. Evidence layout

Each execution stores evidence under a timestamped directory, for example:

```text
e2e-reports/full-user-e2e-<UTC>/
  manifest.json
  summary.md
  U03-http-webhook/
    screenshots/
    browser.log
    api-runtime-evidence.json
    receiver-evidence.txt
    cleanup.txt
  ...
```

`manifest.json` must include `git_head`, build/image identifiers, environment, qualification browser/version, scenario IDs, start/end timestamps and final status. Secrets/tokens/passwords must be redacted.

## 8. Release gate

Full User E2E is release-PASS only when:

- all applicable P0 scenarios PASS;
- all release-required applicable P1/P2 scenarios PASS, or an explicit current release authority documents a bounded deferral;
- no scenario is counted PASS solely because a lower-level test exists;
- AI Gateway/AI Proxy/Phase E and Phase F are excluded from denominator and blockers;
- cleanup succeeds or residual fixtures are explicitly recorded;
- exact-head evidence is attached to the release/Work Packet.

P3 scenarios are qualification-strengthening gates when the release authority assigns concrete browser/accessibility/performance targets. Until then, they remain tracked scenarios and must not be fabricated as PASS.

## 9. Relationship to generated capability inventory

`e2e/capabilities/data-relay-capabilities.yaml` and `e2e/COVERAGE.md` were generated from an older code state and are inputs to the #154 rebuild, not current release authority. Until #154 regenerates them, this specification product-scope gate takes precedence for Full User E2E: historical AI rows and stale Route-OFF/default-false claims are excluded from current Control qualification.
