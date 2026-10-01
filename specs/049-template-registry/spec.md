# 049 Template Registry and Template Builder

## Status

**Specification and design authority only.** This document defines the target model for versioned **Source Packs**, **Template Registry** semantics, **Template Builder** inputs, validation, compatibility, storage layout, and operator UI workflow.

**Not in scope for this spec:**

- Marketplace backend, remote sync, or multi-tenant sharing
- AI-assisted template generation or autonomous publishing
- Runtime changes to StreamRunner, source adapters, or checkpoint commit rules
- Mandatory migration of existing Phase 1 flat JSON templates (see migration notes)

**Related specs:**

- `specs/013-template-connector-system/spec.md` — Phase 1 filesystem registry and instantiate APIs (current implementation)
- `specs/005-generic-http-connector-stream-workflow/spec.md` — Connector/Stream separation and API Test workflow
- `specs/001-core-architecture/spec.md`, `specs/002-runtime-pipeline/spec.md`, `specs/003-db-model/spec.md`, `specs/004-delivery-routing/spec.md` — entity and pipeline invariants
- `specs/047-pipeline-debugger/spec.md` — read-only pipeline inspection (complements template validation UX)

## Purpose

Improve GDC integration templates from simple UI presets into **versioned, verifiable Source Packs** that operators can trust. A Source Pack captures connector, auth, stream, mapping, enrichment, formatter, route recommendations, runtime hints, sample evidence, expected outputs, validation rules, and documentation—without becoming a runtime entity or bypassing Mapping, Enrichment, or Route models.

Templates accelerate onboarding; **Stream** remains the execution unit after materialization.

## Terminology

| Term | Meaning |
| --- | --- |
| **Template** | A versioned **Source Pack** definition stored in the Template Registry (filesystem-first; optional DB index later). |
| **Source Pack** | The full template artifact: presets + samples + validation + docs for one vendor/product/use-case/API version. |
| **Template Registry** | Discovery, metadata, compatibility evaluation, and read APIs over Source Packs. |
| **Template Builder** | Operator or maintainer tooling that produces **draft** Source Packs from docs, OpenAPI, API Test samples, or verified payloads. |
| **Draft template** | A Source Pack not yet approved for general use; may be applied only with explicit operator acknowledgment. |
| **Published template** | A reviewed Source Pack version eligible for guided apply workflow. |
| **Materialization** | Creating normal `Connector`, `Source`, `Stream`, `Mapping`, `Enrichment`, `Checkpoint`, and optional `Route` rows—same semantics as manual CRUD and `specs/013`. |
| **API Test** | Stream request test execution that returns live HTTP response samples (stronger evidence than static docs). |

## Architecture invariants (mandatory)

The following rules from `.specify/memory/constitution.md` apply without exception:

1. **Connector ≠ Stream**; **Source ≠ Destination**.
2. **Stream** is the runtime execution unit.
3. **Route** is the only path from Stream to Destination (fan-out preserved).
4. **Mapping** and **Enrichment** remain separate stages and separate persisted entities.
5. **Checkpoint** updates only after successful destination delivery ACK.
6. **StreamRunner** and runtime core remain vendor-agnostic; no vendor-specific `if/else` in orchestration.
7. New vendor behavior belongs in **adapters/strategies** and template **content**, not runtime core forks.
8. **PostgreSQL only** for platform persistence; templates are filesystem artifacts and must not embed secrets.
9. **English-only** product language for UI, APIs, template files, and operator docs.

Templates MUST NOT:

- Become runtime objects executed by StreamRunner
- Bypass Mapping, Enrichment, or Route on delivery
- Store credentials, tokens, or connection secrets in pack files
- Silently apply when API version compatibility fails

---

## 1. Template Registry

### 1.1 What a template is

A template is **not** pre-filled UI defaults alone. A template is a **Source Pack**: a versioned, reviewable integration package for a specific vendor, product, use case, and API surface.

Each Source Pack MUST be able to express (as presets, samples, or documented recommendations):

| Pack section | Content |
| --- | --- |
| Connector preset | Host pattern, SSL, proxy, shared headers, connector-level options |
| Auth preset | `auth_type` and non-secret field shapes (secret placeholders only) |
| Stream preset | Endpoint, method, params, body template, polling interval, timeout, retry hints |
| Endpoint contract | Path/query/body expectations tied to `api_version` |
| Mapping preset | `event_array_path`, `event_root_path`, `field_mappings_json` |
| Enrichment preset | Static enrichment fields and override policy |
| Formatter preset | Route-level formatter recommendations |
| Route recommendation | Suggested `failure_policy`, rate limits, destination types (not a substitute for operator-chosen Destination rows) |
| Runtime hints | Polling interval bounds, timeout, rate-limit guidance, reliability mode notes |
| Sample payload | Representative raw API response (redacted, no secrets) |
| Expected output | Post-mapping/enrichment preview shape or golden event |
| Validation rules | Machine-checkable rules (see §5) |
| Documentation notes | `docs.md` operator guidance, vendor doc links, caveats |

### 1.2 Versioning and identity

- Every Source Pack MUST declare **vendor**, **product**, **use_case**, and **api_version** (and optional **product_version**).
- Multiple pack versions MAY coexist for the same vendor/product/use_case (e.g. `v1` vs `v2` REST APIs).
- `template_id` MUST be stable and unique within the registry namespace; version bumps SHOULD use manifest fields rather than reusing IDs for incompatible APIs.
- **Deprecation**: `deprecated: true` packs remain discoverable but MUST show warnings and MUST NOT be the default recommendation.

### 1.3 Registry responsibilities

The Template Registry:

1. Indexes Source Packs under `templates/<vendor>/<product>/<use_case>/` (see §6).
2. Exposes list/detail/compatibility APIs (evolution of `specs/013` endpoints).
3. Evaluates **compatibility** between selected pack version and operator environment (see §4).
4. Never executes fetches or updates checkpoints; materialization delegates to normal platform services.

### 1.4 Relationship to Phase 1 (`specs/013`)

Phase 1 flat JSON files (e.g. `templates/generic/rest-polling.json`) are **legacy Source Pack shapes**. New packs SHOULD adopt the directory layout in §6. The registry MUST support reading both shapes during transition:

- Legacy: single `.json` file with embedded defaults (current behavior).
- Target: directory pack with `manifest.yaml` and sidecar artifacts.

Instantiation semantics from `specs/013` remain: created streams are `enabled=false`, `status=STOPPED`, additive CRUD only.

---

## 2. Template Builder

### 2.1 Purpose

Template Builder is maintainer/operator tooling (UI and/or CLI) that **creates draft Source Packs** from evidence sources. It does not publish templates automatically.

### 2.2 Inputs (ordered by evidentiary strength)

| Input | Role | Default confidence |
| --- | --- | --- |
| GDC API Test live response | Ground truth for shape, status codes, pagination fields | `high` |
| Verified user-provided sample payload | Operator-attested capture | `high` (after attestation) |
| OpenAPI / Swagger | Endpoint, parameters, response schemas | `medium` |
| Official vendor API documentation | Auth, rate limits, conceptual field names | `low`–`medium` |

**Policy:** When live API Test samples conflict with static docs or OpenAPI, the builder MUST prefer the **live sample** for field paths, array locations, and example values. Docs/OpenAPI fill gaps only and MUST be flagged in `source_evidence` and `compatibility_notes`.

### 2.3 Builder outputs

For each draft pack, the builder MUST produce:

- `manifest.yaml` with metadata (§3)
- `mapping.json`, `enrichment.json` drafts inferred from samples (editable)
- `sample.raw.json` from API Test or upload
- `sample.expected.json` optional golden output after mapping preview
- `docs.md` with citations to evidence sources and open questions

### 2.4 Draft lifecycle

1. Builder creates pack with `status: draft` in manifest (or registry index).
2. Maintainer reviews mapping paths, checkpoint candidate, and runtime hints.
3. Operator or maintainer marks `status: published` only after review (no AI auto-publish).
4. Published packs may still require per-tenant API Test validation at apply time (§7).

### 2.5 Non-goals (Builder)

- No dependency on external AI services for generation or approval
- No automatic overwrite of published packs without explicit version bump
- No embedding of secrets from API Test sessions into committed files (redaction required)

---

## 3. Template metadata

Every Source Pack MUST include the following metadata (minimum) in `manifest.yaml` or equivalent registry index entry:

| Field | Required | Description |
| --- | --- | --- |
| `template_id` | yes | Stable identifier (e.g. `stellar_malop_v2`) |
| `vendor` | yes | Vendor namespace (directory segment) |
| `product` | yes | Product name (directory segment) |
| `use_case` | yes | Use case slug (directory segment) |
| `source_type` | yes | e.g. `HTTP_API_POLLING`, `DATABASE_QUERY` |
| `api_family` | yes | Logical API family (e.g. `REST`, `GraphQL`, `OCSF_EXPORT`) |
| `api_version` | yes | Vendor API version string the pack targets |
| `product_version` | no | Product/edition version when distinct from API version |
| `auth_type` | yes | Connector auth type preset |
| `verified_at` | no | ISO-8601 timestamp of last human or API Test verification |
| `source_evidence` | yes | List of evidence objects (see below) |
| `confidence_level` | yes | `low` \| `medium` \| `high` |
| `deprecated` | yes | Boolean; default `false` |
| `compatibility_notes` | no | Free-text operator warnings |
| `status` | yes | `draft` \| `published` |
| `pack_version` | yes | Semver or monotonic pack revision for same `template_id` |

### 3.1 `source_evidence` object shape

```yaml
source_evidence:
  - type: api_test | openapi | vendor_doc | user_sample
    ref: "relative/path or URL or run_id"
    captured_at: "2026-05-22T12:00:00Z"
    notes: "optional"
```

### 3.2 Extended optional metadata

- `tags`, `category`, `recommended_destinations` (aligned with Phase 1 list UX)
- `min_platform_version` / `max_platform_version` for GDC feature gates
- `locale` fixed to `en` for product strings

---

## 4. Compatibility policy

### 4.1 Version mismatch

If the operator-selected or environment-detected **API version** differs from the pack’s `api_version`:

- The platform MUST **not** silently apply the template.
- The UI MUST show a **compatibility warning** with explicit mismatch detail (`expected` vs `actual`).
- The operator MAY choose **Apply as draft**: materialize with pack presets marked provisional, then validate via API Test before enabling the stream.

### 4.2 Multi-version support

- The registry MUST support **multiple packs** per vendor/product/use_case (different `api_version` and/or `pack_version`).
- List APIs SHOULD group by vendor → product → use case → versions.
- Default selection MUST prefer non-deprecated packs with highest `confidence_level` and most recent `verified_at` only when versions match; never auto-select across version mismatch.

### 4.3 Runtime and auth compatibility

- `source_type` and `auth_type` on the pack MUST match connector capabilities; mismatch blocks apply with error (not warning).
- SSL, proxy, and rate-limit hints are advisory unless validation rules mark them required (§5).

### 4.4 Evidence staleness

- Packs with `verified_at` older than a configurable threshold (future platform setting) SHOULD surface **stale evidence** warnings.
- Stale packs remain applicable as draft with API Test re-validation.

---

## 5. Validation policy

Validation runs at three layers: **pack lint** (maintainer), **apply-time** (operator), and **post API Test** (operator). Failures are **blocking** or **warning** per rule `severity`.

### 5.1 Required mappings

| Rule ID | Check | Severity |
| --- | --- | --- |
| `MAP-001` | `event_array_path` or explicit single-event mode documented | blocking |
| `MAP-002` | All `field_mappings_json` JSONPaths resolve against `sample.raw.json` | blocking for publish; warning for draft apply |
| `MAP-003` | No duplicate output fields in mapping preset | warning |
| `MAP-004` | Required SIEM/operator fields documented in `docs.md` when not mapped | warning |

### 5.2 Required enrichments

| Rule ID | Check | Severity |
| --- | --- | --- |
| `ENR-001` | Enrichment preset defines minimum static fields (e.g. `vendor`, `product`, `log_type`) | blocking for publish |
| `ENR-002` | Enrichment keys do not collide with mapped output fields | warning |

### 5.3 Required checkpoint candidate

| Rule ID | Check | Severity |
| --- | --- | --- |
| `CHK-001` | `checkpoint_defaults.checkpoint_type` present | blocking for publish |
| `CHK-002` | Checkpoint candidate field(s) documented and JSONPath-tested against sample when incremental | warning |
| `CHK-003` | Reminder: runtime checkpoint still advances only after delivery ACK (no template bypass) | informational |

### 5.4 Sample payload validation

| Rule ID | Check | Severity |
| --- | --- | --- |
| `SMP-001` | `sample.raw.json` is valid JSON (or documented non-JSON mode) | blocking |
| `SMP-002` | No secret-like keys (`password`, `token`, `api_key`, `secret`, …) | blocking |
| `SMP-003` | Sample size under configured max bytes | blocking |

### 5.5 Expected output validation

| Rule ID | Check | Severity |
| --- | --- | --- |
| `OUT-001` | When `sample.expected.json` present, pipeline preview matches within defined tolerance | blocking for publish |
| `OUT-002` | Final preview aligns with destination formatter recommendation | warning |

### 5.6 Event array path validation

| Rule ID | Check | Severity |
| --- | --- | --- |
| `ARR-001` | `event_array_path` resolves to an array in `sample.raw.json` | blocking when array mode |
| `ARR-002` | Array length ≥ 1 in sample (or documented empty-array behavior) | warning |
| `ARR-003` | Live API Test comparison: live path equals or supersedes template path | warning on mismatch; suggest update |

### 5.7 Runtime safety hints

| Rule ID | Check | Severity |
| --- | --- | --- |
| `RT-001` | `polling_interval` within documented vendor limits | warning |
| `RT-002` | `timeout_seconds` ≤ platform max | blocking |
| `RT-003` | Rate limit hints present when vendor doc cites throttling | warning |
| `RT-004` | Reliability mode recommendation compatible with `source_type` (`specs/048`) | informational |

### 5.8 Live comparison (API Test)

After API Test, the platform SHOULD:

1. Diff live response structure vs `sample.raw.json` (paths added/removed/type changes).
2. Score compatibility (`compatible`, `partial`, `incompatible`).
3. Suggest revised `event_array_path`, mapping rows, enrichment, and checkpoint candidate—operator approves before save.

---

## 6. Storage direction

### 6.1 Preferred directory layout

```text
templates/
  <vendor>/
    <product>/
      <use_case>/
        manifest.yaml          # metadata §3 + preset references
        connector_preset.yaml  # optional split; may be inlined in manifest
        stream_preset.yaml
        mapping.json
        enrichment.json
        formatter_preset.yaml  # optional
        route_recommendation.yaml
        sample.raw.json
        sample.expected.json   # optional
        docs.md
```

### 6.2 Manifest responsibilities

`manifest.yaml` MUST:

- Include all §3 metadata fields
- Reference sidecar files or inline presets consistently
- Declare `pack_version` and `api_version`
- Set `status: draft | published`

### 6.3 Legacy coexistence

- Existing `templates/**/*.json` files remain valid Phase 1 packs until migrated.
- Registry loader SHOULD normalize legacy JSON into an in-memory Source Pack view for APIs.

### 6.4 Secrets

- **Forbidden** in any template file: passwords, tokens, API keys, client secrets, session cookies.
- Use placeholder keys in `connector_preset` / `auth_preset` and collect secrets only at instantiation via existing credential forms.

---

## 7. UI workflow (guided apply)

Operator flow for **published** HTTP API packs (other `source_type` values follow analogous steps):

```text
1. Select Vendor → Product → Use Case → API Version
2. GDC shows compatibility status (match / mismatch / stale / deprecated)
3. Operator enters auth only (host + credentials); no full stream re-entry
4. API Test runs against selected connector/stream draft config
5. GDC compares live response vs template sample/schema (§5.8)
6. GDC suggests event_array_path, mapping, enrichment, checkpoint candidate
7. Operator reviews diffs, approves adjustments
8. Operator creates/updates stream (still disabled by default)
9. Optional: create route to chosen destination from recommendation
10. Operator enables stream after destination and mapping validation
```

### 7.1 UX requirements

- Compatibility warnings MUST be visible before apply confirmation.
- **Apply as draft** MUST be explicit (checkbox or secondary action).
- Mapping UI MUST retain preview-first workflow (`constitution.md` Mapping UI rules).
- Suggested changes from API Test MUST NOT auto-save without operator approval.
- English-only labels and messages.

### 7.2 Navigation (future)

- Template Library entry may live under Connectors or a dedicated Templates area; sidebar order unchanged until product decision.
- Deep links: template detail → instantiate → stream runtime / mapping preview.

---

## 8. Non-goals

| Non-goal | Rationale |
| --- | --- |
| Marketplace backend | No remote catalog, billing, or sharing in this phase |
| AI automation | No LLM dependency for build or publish |
| StreamRunner vendor branches | Adapters only; templates supply config |
| Template bypass of Mapping/Enrichment/Route | Materialization creates normal rows; pipeline unchanged |
| Secrets in template files | Security and portability |
| Template-as-runtime-entity | Preserves `specs/013` boundary |
| SQLite or non-PostgreSQL stores | Constitution database policy |

---

## 9. API evolution (design targets)

Phase 1 endpoints (`specs/013`) evolve additively:

| Endpoint | Enhancement |
| --- | --- |
| `GET /api/v1/templates` | Filter by vendor, product, use_case, api_version; return compatibility hints |
| `GET /api/v1/templates/{template_id}` | Return full Source Pack manifest + validation summary |
| `GET /api/v1/templates/{template_id}/compatibility` | Evaluate version match for query params |
| `POST /api/v1/templates/{template_id}/instantiate` | Support `apply_mode: strict \| draft`; reject silent mismatch in `strict` |
| `POST /api/v1/templates/builder/draft` | (Future) Accept OpenAPI upload or API Test run reference |

No endpoint may commit runtime checkpoints or invoke StreamRunner.

---

## 10. Implementation phases (informative)

| Phase | Scope |
| --- | --- |
| **A (current)** | Flat JSON registry + instantiate (`specs/013`) |
| **B** | Directory Source Packs + manifest loader + metadata APIs |
| **C** | Compatibility warnings + apply-as-draft + API Test diff |
| **D** | Template Builder UI/CLI for draft generation from OpenAPI/samples |
| **E** | Pack lint CI + publish workflow + migration of built-in packs |

---

## 11. Acceptance criteria (spec-only)

1. A reader can define a new Source Pack directory without contradicting entity separation rules.
2. API version mismatch cannot be applied silently in `strict` mode (documented UX and API contract).
3. Live API Test evidence is defined as stronger than static docs for path inference.
4. Validation rules cover mapping, enrichment, checkpoint candidate, samples, and runtime hints.
5. Storage layout under `templates/<vendor>/<product>/<use_case>/` is normative for new packs.
6. Non-goals explicitly forbid marketplace, AI, StreamRunner vendor logic, and secret storage.

---

## Open questions

1. **Pack signing**: Should published packs require maintainer signature or checksum in manifest?
2. **OpenAPI ingestion**: Single-file upload vs URL fetch (security review for SSRF)?
3. **Checkpoint candidate auto-detection**: Heuristic library per vendor vs manual-only in Phase C?
4. **DB-backed registry index**: When does PostgreSQL index outweigh filesystem-only discovery?
5. **Template RBAC**: Can operators publish drafts, or only administrators?
6. **Migration deadline**: Target date to convert built-in `templates/*.json` to directory packs?

---

## DATA RELAY MARKETPLACE ADDENDUM v1.0 — Relationship to Connector Marketplace

Status: M29.0–M29.1 Implementation In Progress
Authority: Additive only. Existing Source Pack materialization and runtime invariants remain authoritative.
Reference: `docs/architecture/DATA-RELAY-CONNECTOR-MARKETPLACE-ARCHITECTURE-CHARTER-v1.0-DRAFT.md`

This specification's **Source Pack** remains the canonical source-integration content model for Marketplace.

Marketplace does not introduce a competing runtime entity called Connector Pack. `Connector Pack` is a UX synonym only.

Marketplace adds outer-layer concerns around Source Pack:

- package distribution origin: builtin / upload / git / registry
- manifest compatibility and validation
- signature / trusted publisher metadata
- license / provenance metadata
- install / upgrade / rollback / uninstall lifecycle
- trust/support tiers
- Stream Extension Pack dependency declarations
- external open-source import
- AI-assisted draft generation

M29.1 evolves connector manifests additively and preserves legacy manifest compatibility. Legacy `version` remains readable while normalized in-memory `pack_version`, `package_id`, and `package_kind` are exposed without rewriting existing package files.

The existing non-goals in the original body remain correct for spec 049 itself. M29 Marketplace is the approved outer workstream implementing those distribution/lifecycle concerns while preserving every Source Pack runtime/materialization invariant here.
