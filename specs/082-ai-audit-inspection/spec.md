# Spec 082 — AI Audit & Inspection Hardening (M23)

**Status:** Outside Data Relay Control (Phase E) — separate-domain / historical reference only; not current Control implementation authority

## Scope

Strengthen audit and operational visibility for AI request/response inspection without
introducing new runtime pipelines, approval workflows, or governance dashboards.

## In scope

- `ai_audit_events` entity and persistence
- Inspection evidence (matched rule/pattern, action, provider, model — no raw prompt/response)
- `GET /api/v1/ai-audit-events` with filters and request correlation
- Audit metrics (inspected/blocked/masked/redacted) by provider and stream
- AI Traffic dashboard KPI extension (Policy Blocks, Prompt Masks, Response Masks)
- RBAC capability `ai_audit_read`
- Unit, API, integration, and E2E tests

## Out of scope (M24+)

- AI Governance Dashboard
- Approval workflow / human review queue
- New runtime or AI pipeline

## Event types

| event_type | When |
|------------|------|
| PROMPT_INSPECTED | Prompt inspection completed with allow |
| PROMPT_BLOCKED | Prompt block/deny enforcement |
| PROMPT_MASKED | Prompt mask/redact enforcement |
| RESPONSE_INSPECTED | Response inspection completed with allow |
| RESPONSE_BLOCKED | Response block/deny enforcement |
| RESPONSE_MASKED | Response mask/redact enforcement |

## Security

- Never persist raw prompt or response text in audit events.
- Evidence fields: `matched_rule`, `matched_pattern`, `action`, `provider`, `model`.

## Correlation

- `request_id` links audit events to AI stream, provider, policy rule, and delivery logs.

## RBAC

- `ai_audit_read`: ADMINISTRATOR, CONNECTOR_OPERATOR, VIEWER (same tier as `ai_policy_read`).
