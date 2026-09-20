# Data Relay Source-of-Truth Documents

This directory contains the product/UX documents explicitly designated as current by `docs/architecture/source-of-truth-index.md`.

Presence in this directory is not, by itself, an authority rule. The index defines the current set and hierarchy.

## Current designated set

| Role | File | Filename version | Internal header version | Integrity note |
|---|---|---:|---:|---|
| Top-level product charter | `PRODUCT-CHARTER-Version-1.2.1-FINAL.txt` | 1.2.1 | 1.2.1 | aligned |
| Product roadmap / milestone plan | `MASTER-WBS-Version-1.2.1-FINAL.txt` | 1.2.1 | 1.2.1 | aligned |
| UX charter | `DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt` | 1.2.1 | 1.1 | **metadata mismatch — do not infer a version rewrite** |
| Stream Wizard UX charter | `DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt` | 5.2 | 3.0 | **metadata mismatch — do not infer a version rewrite** |
| Governance UX charter | `GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt` | 1.1 | 1.0 | **metadata mismatch — do not infer a version rewrite** |
| Governance Workspace UX charter | `DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt` | 1.1 | 1.0 | **metadata mismatch — do not infer a version rewrite** |
| Governance Workspace product spec | `DATA-RELAY-GOVERNANCE-WORKSPACE-v1.1-FINAL.txt` | 1.1 | 1.0 | **metadata mismatch — do not infer a version rewrite** |
| Governance / Transform policy | `DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt` | 1.1 | 1.0 (Draft) | **status/version metadata mismatch; content retained unchanged** |
| Union Schema UX spec | `DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt` | 1.1 | 1.0 | **metadata mismatch — do not infer a version rewrite** |

## Rules

- The Product Charter is the top-level product authority.
- The Master WBS is subordinate planning authority and cannot expand product scope beyond the Product Charter.
- Domain-specific UX/product documents are subordinate to the Product Charter.
- Current implementation specs under `specs/` translate intended behavior into engineering contracts; they cannot override higher product authority.
- Code/schema/config/runtime/tests describe what exists now; implementation drift does not silently rewrite intended behavior.
- If current normative documents conflict, fail closed and request an explicit decision.
- Do not edit version/status metadata merely to make filenames and headers match; the current mismatch is recorded intentionally until an explicit source-document decision is made.

## Staging

`docs/source-of-truth/_incoming/` is transient local staging only and must not be committed. Imported documents must be compared, promoted deliberately, and then removed or archived.
