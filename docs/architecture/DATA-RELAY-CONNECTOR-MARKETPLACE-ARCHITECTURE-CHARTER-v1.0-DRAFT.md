# DATA RELAY CONNECTOR MARKETPLACE ARCHITECTURE CHARTER

Version 1.0 Draft

Status: Post-v1 Deferred Architecture Reference — Final Marketplace specification pending
Baseline: `wave2-marketplace-baseline` @ `362a57dec43d321138fa8aafc848fbfc80303807`

Owner scope decision (2026-10-01): Marketplace is not part of Data Relay Control v1 completion/release scope. Existing implemented foundations may be preserved, but remaining M29 work — including Harvester, AI Builder, Git/remote acquisition, Marketplace UI expansion, and Remote/Public Registry — must not resume until a future final Marketplace specification is explicitly approved.

---

## 1. Purpose

This document defines the target architecture, product boundaries, package model, trust model, authoring model, validation model, distribution model, and implementation roadmap for the Data Relay Connector Marketplace.

The Marketplace exists to make Data Relay integrations installable, upgradeable, reviewable, and reusable without adding vendor-specific logic to the Data Relay runtime core.

This document is additive. It does not remove or weaken any existing Product Charter, Stream/Route, Governance, Credential, Reliability, Checkpoint, or Runtime invariant.

---

## 2. Product Objective

Data Relay should allow a user, partner, maintainer, or AI coding assistant to create a reusable integration package from:

- vendor API documentation
- OpenAPI / Swagger
- API Test output
- sample JSON or other supported payloads
- an existing Data Relay integration
- an eligible open-source connector implementation

The resulting package can then be validated, reviewed, installed, upgraded, rolled back, removed, and optionally published through the Marketplace.

Primary target experience:

```text
Vendor Docs / Existing Script / Open Source Connector / Sample Payload
                              ↓
                 ChatGPT / Claude Code / Cursor
                    or Data Relay Builder
                              ↓
                    Data Relay Package
                              ↓
                    Data Relay Validator
                              ↓
               Draft / Private / Community
                    / Verified / Official
                              ↓
             File / Git / Registry / Built-in
                              ↓
                     Unified Registry
                              ↓
                   Install / Configure
                              ↓
                       Stream Wizard
                              ↓
                 Existing Data Relay Runtime
```

---

## 3. Marketplace Is Not a Parallel Runtime

Marketplace is an acquisition, packaging, validation, provenance, and lifecycle layer.

Marketplace MUST NOT create:

- a second Stream runtime
- a second connector execution engine
- a second authentication engine
- a second delivery engine
- a second retry engine
- a second checkpoint implementation
- a second governance engine

Installed integrations MUST resolve into existing Data Relay models, adapters, strategies, and runtime contracts.

Runtime remains authoritative.

---

## 4. Relationship to Existing Source Pack Architecture

`specs/049-template-registry` already defines the canonical Data Relay **Source Pack** concept, including:

- vendor/product/use-case identity
- connector and auth presets
- stream presets
- mapping and enrichment
- samples and expected output
- validation rules
- `pack_version`
- `api_version`
- `source_evidence`
- draft/published lifecycle
- compatibility checks
- no secrets in pack files
- materialization into normal Data Relay entities

Marketplace MUST evolve this model rather than create a competing package architecture.

Terminology:

- **Marketplace Package** — distributable and installable package envelope.
- **Source Pack** — canonical source integration content model defined by `specs/049`.
- **Connector Pack** — UX-friendly synonym for a source integration package; it is NOT a new runtime entity and MUST NOT collapse Connector and Stream into one entity.
- **Stream Extension Pack** — a package that adds one or more stream definitions, mappings, enrichments, samples, and tests to an existing connector/source-pack family.
- **Destination Pack** — future optional package kind for declarative destination integrations. Not required for Marketplace V1.

Existing architecture rule remains mandatory:

```text
Connector ≠ Stream
Source ≠ Destination
Stream = Runtime Execution Unit
Route = Destination-specific Processing Unit
```

---

## 5. Package Kinds

### 5.1 Source Pack

A Source Pack may describe:

- vendor/product identity
- connector non-secret configuration shape
- authentication type and secret placeholders
- one or more stream definitions
- endpoint contracts
- request method/path/query/body
- pagination and cursor behavior
- mapping
- enrichment
- formatter recommendations
- runtime hints
- sample payloads
- expected outputs
- validation rules
- documentation

Installing a Source Pack makes the integration definition available to Data Relay. Installation alone MUST NOT silently enable a Stream or start polling.

### 5.2 Stream Extension Pack

A Stream Extension Pack adds stream capability to an existing connector/source-pack family.

Example:

```text
Cybereason Source Pack
  ├─ Malop
  └─ Hunting Extension
```

A Stream Extension Pack MUST declare a dependency such as:

```yaml
package_kind: stream_extension
requires:
  package_id: cybereason
  version: ">=1.0.0 <2.0.0"
```

It MUST NOT embed credentials and MUST NOT replace shared authentication/runtime behavior.

### 5.3 Destination Pack

Destination Pack support is a future extension. When introduced it MUST reuse the existing Destination and Route delivery architecture rather than execute arbitrary package code.

---

## 6. Declarative Package Rule

Marketplace V1 packages MUST be declarative.

Allowed examples:

- YAML / JSON metadata
- HTTP request definitions
- authentication references and non-secret field shapes
- pagination / cursor definitions
- mapping definitions
- enrichment definitions
- schemas
- fixtures
- expected output
- compatibility metadata
- documentation

Marketplace V1 MUST NOT execute arbitrary package-supplied:

- Python
- JavaScript
- shell scripts
- native binaries
- arbitrary plugins loaded into the Data Relay process

If executable extensions are ever introduced, they MUST be a separate future package class with explicit sandboxing, resource limits, trust policy, and security review.

---

## 7. Manifest and Metadata Ownership

Marketplace package metadata MUST distinguish between package-declared metadata and platform-derived metadata.

### 7.1 Package-declared metadata

Representative fields:

```text
schema_version
package_id
package_kind
vendor
product
use_case
pack_version
api_version
source_type
auth_type
capabilities
requires
min_platform_version
max_platform_version
source_evidence
license
upstream_provenance
```

Existing legacy `version` manifests MUST be supported during transition. `pack_version` is the canonical package revision field once normalized.

If both legacy `version` and `pack_version` exist and differ, validation MUST fail.

### 7.2 Platform-derived metadata

The following MUST NOT be trusted merely because a package declares them:

- `installed_from`
- installed version
- install status
- signature verification status
- trust/support tier
- validation status
- publisher approval
- current/previous version
- rollback state

These values are owned by the Data Relay registry/install record.

`installed_from` values may include:

- `builtin`
- `upload`
- `git`
- `registry`

---

## 8. Unified Registry

Built-in and externally installed integrations MUST use the same logical package contract and registry APIs.

Physical origins may differ:

```text
Built-in Packages       → product-owned package root
Installed Packages      → managed plugin/package root
Uploaded Packages       → validated then installed root
Git Packages            → fetched, validated, then installed root
Remote Registry         → fetched, validated, then installed root
```

The registry MUST normalize them into one catalog view.

Built-in packages may be non-removable by policy, but MUST NOT require a separate runtime architecture.

---

## 9. Package Lifecycle

Required lifecycle:

```text
Discover
  ↓
Acquire
  ↓
Validate
  ↓
Review / Approve when required
  ↓
Install
  ↓
Configure / Materialize
  ↓
Activate Stream explicitly
  ↓
Upgrade / Rollback / Uninstall
```

Rules:

1. Install MUST NOT automatically create credentials.
2. Secrets MUST NOT exist in package files.
3. Install MUST NOT automatically enable Streams.
4. Upgrade MUST NOT silently modify a running Stream configuration.
5. Existing runtime entities SHOULD remain pinned to the package/version used to create or update them until an operator explicitly applies a compatible update.
6. Rollback MUST NOT roll back checkpoint/runtime data implicitly.
7. Uninstall MUST be blocked or require explicit dependency handling when active configuration depends on the package.

---

## 10. Trust, Publication, and Support Are Separate Concepts

Publishing state and trust/support level MUST be separate.

### 10.1 Publication state

- `draft`
- `published`
- `deprecated`

### 10.2 Marketplace trust/support tier

Recommended tiers:

- **Local Draft** — locally created, not published.
- **Private** — approved for one organization/private registry.
- **Imported** — mechanically imported and static validation completed; no live vendor validation guarantee.
- **Community** — package and fixtures pass automated validation; support/community provenance may vary.
- **Verified** — live vendor API behavior has been validated with recorded evidence.
- **Official** — Data Relay-owned/supported package with continuous regression expectations.

A package MUST NOT self-assign `Verified` or `Official` authority.

---

## 11. Data Relay Validator

Marketplace requires a first-class validation framework comparable in role to an application package inspection gate.

Validation categories:

### Package integrity

- supported archive format
- path traversal rejection
- size/file-count limits
- duplicate path rejection
- canonical digest
- manifest/schema validation
- dependency validation
- platform compatibility

### Security

- no embedded secrets
- no executable code in V1
- signature verification when required
- trusted publisher/key checks
- URL and SSRF policy
- unsafe auth-side request detection
- forbidden file types

### Integration contract

- source/auth type compatibility
- request method/path/body validation
- pagination contract
- cursor/checkpoint candidate
- response/event array selector
- mapping validation
- enrichment validation
- sample fixture parsing
- expected output comparison
- rate-limit/runtime hints

### Runtime invariants

- checkpoint only after required delivery success
- no bypass of Mapping/Enrichment/Route
- no vendor-specific runtime fork
- credentials resolved through Connected Credential/runtime auth
- existing resilience/rate-limit/backpressure/circuit/adaptive-concurrency layers remain authoritative

Validation result MUST distinguish blocking failures from warnings.

---

## 12. Security Boundary

The following Wave 2 architecture remains authoritative for every installed package:

- Connected Credential
- AES-256-GCM encryption at rest
- `auth_json_for_runtime`
- OAuth2 Authorization Code
- PKCE
- refresh token lifecycle
- OAuth2 Client Credentials
- Basic / Bearer / API Key
- session login
- HTTP Resilience
- Source Rate Limiter
- Durable Delivery Queue
- Webhook queue
- SYSLOG_TCP queue
- restart recovery
- Backpressure
- Circuit Breaker
- Adaptive Concurrency
- Runtime Observability
- Checkpoint invariant

Marketplace packages MUST reference these capabilities. They MUST NOT carry alternative implementations of them.

---

## 13. Governance and Administration Boundary

Package governance is an Administration concern, not a replacement for Stream/Route data governance.

Administration may manage:

- package install policy
- allowed package origins
- trusted signing keys
- publishers
- signature requirements
- license policy
- private registry configuration
- publish/review workflow
- package audit history

Existing Governance Workspace continues to govern data behavior such as protection, classification, policy, violations, quarantine, and replay.

Marketplace MUST NOT become an additional default Stream Wizard governance step.

---

## 14. AI Authoring Model

AI-assisted creation is a first-class Marketplace authoring workflow.

Supported authoring agents may include:

- ChatGPT
- Claude Code
- Cursor
- other coding agents capable of following the Data Relay Package Specification
- future built-in Data Relay Builder

Target workflow:

```text
User provides vendor docs / OpenAPI / sample / existing script
                         ↓
AI generates draft Source Pack or Stream Extension Pack
                         ↓
Local Data Relay Validator
                         ↓
Fixture / API Test comparison
                         ↓
Human review where required
                         ↓
Local Draft / Private / Published package
```

AI output MUST start as untrusted draft content.

AI MUST NOT auto-publish a package as Verified or Official.

The package SHOULD record generation/provenance metadata including evidence URLs/paths and the source inputs used.

---

## 15. External Open-Source Connector Import

Marketplace should reduce manual connector development by importing eligible open-source integration knowledge.

Target pipeline:

```text
Open Source Connector Ecosystems
           ↓
Connector Harvester
           ↓
License + Provenance Gate
           ↓
AUTO_PORT_CANDIDATE / REVIEW_ADAPT / REFERENCE_ONLY
           ↓
AI / Deterministic Translator
           ↓
Data Relay Source Pack / Stream Extension Pack
           ↓
Data Relay Validator
           ↓
Imported / Community / Verified / Official
```

The importer SHOULD extract only integration knowledge such as:

- endpoints
- request contracts
- auth requirements
- pagination
- cursors
- schemas
- mappings
- fixtures
- documented rate limits

It MUST NOT import a foreign connector runtime as a replacement for Data Relay core reliability/security behavior.

---

## 16. License and Provenance Policy

Every external import MUST have package-level provenance.

Minimum provenance:

```text
upstream_project
upstream_url
upstream_path
upstream_commit_or_version
license_spdx_or_detected_license
license_source
notice_required
modified_from_upstream
import_method
source_evidence
```

Default license gate:

- MIT / Apache-2.0: candidate for porting after checking the specific upstream artifact and attribution obligations.
- MPL and other reciprocal/file-level licenses: review/adapt before inclusion.
- ELv2, Sustainable Use licenses, source-available, proprietary, unclear, or no-license code: reference-only by default unless explicit legal/product approval permits more.
- Parent repository license MUST NOT automatically be assumed to cover every third-party connector or embedded artifact.

Unknown license = no direct import.

License approval does not imply technical verification.

---

## 17. Preferred External Ecosystem Sources

Initial harvesting should prioritize ecosystems whose integration structure maps well to Data Relay and whose individual artifacts pass the license gate.

Candidate sources include:

- Meltano / Singer taps and targets
- OpenTelemetry Collector Contrib receivers/exporters
- Fluent Bit input/output plugins
- Telegraf input/output plugins

Other ecosystems such as Airbyte, Elastic integrations, n8n, Vector, or vendor/community repositories may be useful as references, but each artifact MUST pass the license/provenance gate before direct reuse.

Marketplace architecture MUST NOT depend on a third-party ecosystem remaining available.

---

## 18. Air-Gapped and Enterprise Operation

Marketplace MUST remain usable in disconnected environments.

Required offline-compatible paths:

- built-in packages
- local package upload
- offline signed package bundle
- private/internal registry when configured

Remote public registry MUST be optional and SHOULD default OFF until explicitly enabled by an administrator.

Git/remote acquisition MUST obey network allowlist/SSRF controls.

---

## 19. UX Principles

Marketplace MUST preserve Data Relay simplicity.

Primary navigation SHOULD remain aligned with the current product model. Marketplace discovery should live under Data Sources / Connectors rather than create unnecessary top-level navigation unless later UX evidence justifies it.

Expected flows:

### Existing package

```text
Data Sources → Connectors → Browse Integrations
→ Select package → Review trust/version/streams → Install
→ Configure Credential → Select Stream(s) → Continue Wizard
```

### Missing integration

```text
Can't find your integration?
→ Upload Package
→ Install from Git
→ Create with AI
```

### Stream extension

```text
Existing Connector
→ Available Streams
→ Install Stream Extension
→ Configure / Enable explicitly
```

UI MUST show, when relevant:

- package version
- vendor API version
- origin
- trust/support tier
- verification status/date
- license/provenance
- compatibility warnings
- installed/update status

The UI MUST NOT expose raw package internals before they are needed.

---

## 20. Union Schema and Schema Drift

Package schemas, fixtures, and mappings are onboarding evidence and configuration input.

They MUST NOT replace runtime truth.

Rules:

- live/API Test payload beats stale static documentation for field shape
- package schema may seed preview or compatibility checks
- Union Schema remains Stream scope
- Schema Drift baseline remains governed by the existing runtime policy
- package upgrade MUST NOT silently rewrite an established runtime schema baseline
- detected incompatibility must surface as an operator-visible warning/block according to existing schema policy

---

## 21. Route Processing Boundary

Marketplace does not change Route Processing order:

```text
Transform → Protection → Classification → Policy → Delivery
```

Package recommendations may suggest mapping, enrichment, formatter, reliability, or destination settings, but the final materialized configuration remains normal Data Relay configuration and existing policy/governance rules win.

One Stream → Many Routes → Many Destinations remains mandatory.

---

## 22. Versioning, Upgrade, and Rollback

Marketplace package version and vendor API version MUST remain distinct.

- `pack_version` = Data Relay package revision
- `api_version` = external vendor API revision

Upgrade checks SHOULD include:

- package compatibility
- platform compatibility
- vendor API compatibility
- stream/mapping/schema changes
- deprecated streams
- dependency changes
- required credential/auth capability changes

Existing deployed Streams MUST NOT silently follow a new package version.

Upgrade requires explicit apply/reconcile semantics.

Rollback returns package/catalog configuration to a prior supported version but does not silently rewind Stream checkpoints or delivered data.

---

## 23. Audit and Observability

Marketplace lifecycle actions SHOULD be auditable:

- acquired
- validation started/completed
- signature checked
- license decision
- installed
- upgraded
- rollback
- uninstall
- publish/unpublish/deprecate
- publisher/key administration

Runtime event delivery remains recorded through existing runtime observability; package lifecycle telemetry MUST NOT replace it.

---

## 24. Migration of Existing Built-in Integrations

Existing built-in integrations should be normalized into the common package contract rather than detached and rebuilt later.

Migration principle:

1. Define package contract.
2. Make legacy/current built-ins readable through compatibility normalization.
3. Add unified registry/multi-root.
4. Normalize existing built-ins to the package format without changing runtime behavior.
5. Add missing/unverified connector content through the Marketplace package path.
6. Preserve evidence/trust classification; do not upgrade confidence merely because content was imported.

Current connector audit implications:

- existing complete/shared connector content remains authoritative
- missing content should not be re-added directly to core merely to be moved later
- unverified Orca/SentinelOne/Wiz-style content enters as Imported/Community until verification evidence exists
- stream-only additions such as Cybereason Hunting are candidates for Stream Extension Packs

---

## 25. Database and Migration Policy

Marketplace schema changes MUST be created as new migrations from the current Data Relay Alembic head.

Historical/fork migration files MUST NOT be cherry-picked into the current chain.

Marketplace persistence should cover platform-owned lifecycle metadata such as:

- installed package identity/version
- origin
- status
- digest/signature result
- trust/validation result
- dependency state
- registry version/cache invalidation state

Credential OAuth/token persistence remains a separate domain.

---

## 26. WBS — Marketplace Workstream

Marketplace is a post-v1 deferred workstream. Existing foundations do not change historical Phase A–D completion percentages and do not contribute to Data Relay Control v1 completion or release readiness.

Recommended milestone:

### M29 — Connector Marketplace & Ecosystem

- **M29.0** Marketplace / Source Pack specification consolidation
- **M29.0a** License and provenance specification
- **M29.0b** External connector import specification
- **M29.1** Manifest v2 + backward compatibility
- **M29.2** Unified built-in / installed multi-root registry
- **M29.3** Package lifecycle: safe acquire, install, upgrade, rollback, uninstall
- **M29.4** Validator + registry cache/version/invalidation
- **M29.5** Marketplace security: signing, trusted keys, RBAC, secret scan, SSRF policy
- **M29.6** Connector Harvester / external import pipeline
- **M29.7** AI Connector Translator / Builder authoring contract
- **M29.8** Marketplace UI
- **M29.9** Remote Registry / private registry integration; remote public registry optional and OFF by default

After M29 package/platform completion:

- normalize existing connector packages
- add/verify missing connector and stream content
- run targeted integration regression
- run final 32,184 Full Matrix acceptance
- run 7 human acceptance scenarios

---

## 27. Acceptance Gates

Marketplace implementation is not complete until the applicable gates pass.

### Architecture

- one package contract for built-in and installed integrations
- no vendor-specific runtime forks
- no parallel auth/retry/delivery/checkpoint engines

### Security

- no plaintext secrets in packages
- no executable package code in V1
- archive/path traversal protection
- SSRF controls
- signature/trust enforcement according to policy
- license/provenance recorded

### Lifecycle

- install
- upgrade
- rollback
- uninstall/dependency protection
- offline installation

### Compatibility

- legacy built-in manifests remain supported during migration
- Source Pack/spec 049 compatibility retained
- running Streams do not silently change on package upgrade

### Validation

- package validator tests
- fixture/API contract tests
- credential/auth representative tests
- checkpoint/reliability regression
- targeted Marketplace E2E
- final Full Matrix at the agreed integration point

---

## 28. Competitive Design Precedents — Non-Normative

The architecture intentionally borrows patterns rather than product code:

- Splunk: installable App/Add-on ecosystem and package inspection/validation gate
- Elastic: package specification, registry, installation lifecycle, signature-oriented distribution, air-gap support
- Airbyte: connector builder and AI-assisted connector authoring concepts
- Cribl: Pack distribution from multiple sources and controlled custom-code policy
- Meltano/Singer: reusable tap/target integration ecosystem and structured REST connector concepts
- OpenTelemetry / Fluent Bit / Telegraf: broad open-source receiver/input/output ecosystems

These are design references only. Reuse of third-party code or connector definitions is controlled by the license/provenance policy in this document.

---

## 29. Explicit Non-Goals for Marketplace V1

Marketplace V1 is NOT:

- a general application store
- a Python/JavaScript plugin execution platform
- a workflow engine
- an IAM platform
- an AI agent hosting platform
- a replacement for Data Relay Governance
- a replacement for Stream Wizard
- a mechanism to bypass Data Relay security/reliability controls

---

## 30. Authority and Conflict Resolution

Until implementation is complete:

1. PRODUCT-CHARTER remains highest product authority.
2. Runtime Is Truth remains mandatory.
3. Existing Source Pack and runtime invariants remain valid unless an explicitly approved newer specification supersedes them.
4. Marketplace definitions are additive and implementation-pending.
5. Documentation MUST NOT claim Marketplace features are available before code, tests, and migration readiness prove them.

When Marketplace implementation is explicitly resumed under a future approved final specification, detailed implementation specs MUST preserve all existing runtime/security boundaries and re-audit this draft before treating it as implementation authority.
