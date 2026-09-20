#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

echo "===== CHECK EXISTING SPEC-KIT ====="
test -d tools/spec-kit || { echo "ERROR: tools/spec-kit submodule not found"; exit 1; }
test -d specs || { echo "ERROR: specs directory not found"; exit 1; }

echo "===== UPDATE SUBMODULE IF NEEDED ====="
git submodule update --init --recursive tools/spec-kit

echo "===== CREATE SPECIFY MEMORY ====="
mkdir -p .specify/memory
mkdir -p .cursor/rules

cat > .specify/memory/constitution.md <<'CONSTITUTION'
# Generic Data Connector Platform Constitution

## Source of Truth

This project already uses Spec Kit style specs under:

- specs/001-core-architecture/spec.md
- specs/002-runtime-pipeline/spec.md
- specs/003-db-model/spec.md
- specs/004-delivery-routing/spec.md

These specs and this constitution are the implementation authority.

## Non-Negotiable Architecture Rules

1. Connector and Stream must remain separate.
2. Source and Destination must remain separate.
3. Stream is the runtime execution unit.
4. Stream and Destination are connected only through Route.
5. Multi Destination fan-out must be preserved.
6. Mapping and Enrichment must remain separate stages.
7. Checkpoint must be updated only after successful Destination delivery.
8. Source rate limit and Destination rate limit must both exist.
9. Delivery failure logs must be structured and persisted.
10. MVP focuses on HTTP API polling but must not block future DB Query or Webhook Receiver expansion.

## Required Runtime Pipeline

Source Fetch
→ Event Extraction
→ Mapping
→ Enrichment / Static Field Injection
→ Formatting
→ Route Fan-out
→ Destination Delivery
→ Checkpoint Update
→ Structured Logs / Runtime State

## Forbidden

- Do not collapse Connector, Source, Stream, Destination, and Route into one object.
- Do not make Connector the runtime unit.
- Do not update checkpoint after fetch/parse/mapping only.
- Do not bypass Route for Destination delivery.
- Do not merge Mapping and Enrichment into one unclear function.
- Do not change unrelated files.
- Do not introduce distributed queue/large pipeline architecture for MVP.
CONSTITUTION

cat > .specify/specs-index.md <<'INDEX'
# Spec Index

## 001 Core Architecture
Path: `specs/001-core-architecture/spec.md`

Defines:
- Connector / Source / Stream / Destination / Route separation
- Core platform boundaries
- MVP architecture constraints

## 002 Runtime Pipeline
Path: `specs/002-runtime-pipeline/spec.md`

Defines:
- Stream runtime execution
- Polling pipeline
- Mapping / Enrichment / Fan-out / Checkpoint order
- Failure behavior

## 003 DB Model
Path: `specs/003-db-model/spec.md`

Defines:
- Connector, Source, Stream, Mapping, Enrichment, Destination, Route, Checkpoint, Log models
- DB relationship rules

## 004 Delivery Routing
Path: `specs/004-delivery-routing/spec.md`

Defines:
- Multi destination routing
- Syslog/Webhook delivery
- Route failure policy
- Destination rate limit
INDEX

cat > .cursor/rules/spec-kit-gdc.mdc <<'CURSOR_RULE'
---
description: Generic Data Connector Platform existing Spec Kit rules
alwaysApply: true
---

# Existing Spec Kit Integration Rules

This repository already has Spec Kit materials:

- `tools/spec-kit`
- `specs/001-core-architecture/spec.md`
- `specs/002-runtime-pipeline/spec.md`
- `specs/003-db-model/spec.md`
- `specs/004-delivery-routing/spec.md`
- `.specify/memory/constitution.md`
- `.specify/specs-index.md`

Before code changes:
1. Read the related spec under `specs/`.
2. Follow `.specify/memory/constitution.md`.
3. Do not create a conflicting architecture.

Implementation constraints:
- Connector != Stream.
- Source != Destination.
- Stream is the execution unit.
- Route connects Stream to Destination.
- Mapping happens before Enrichment.
- Checkpoint updates only after successful Destination delivery.
- Source rate limit and Destination rate limit are separate.
- Delivery failures must be logged structurally.
- Modify only files required by the task.

When adding new work:
- Create a new numbered spec under `specs/NNN-feature-name/spec.md`.
- Do not overwrite existing specs unless explicitly requested.
- Keep implementation aligned with 001~004 specs.
CURSOR_RULE

echo "===== VALIDATION ====="
echo "[1] specs"
find specs -maxdepth 2 -type f | sort

echo
echo "[2] spec-kit submodule"
git submodule status tools/spec-kit || true

echo
echo "[3] created files"
ls -la .specify .specify/memory .cursor/rules

echo
echo "DONE: existing Spec Kit structure integrated."
