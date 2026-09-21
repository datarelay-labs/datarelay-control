# 081 — AI Policy Enforcement (M22)

**Status:** Outside Data Relay Control (Phase E) — separate-domain / historical reference only; not current Control implementation authority

## Scope

Enforcement layer for AI prompt/response traffic on existing Stream pipeline + `AI_PROVIDER_POST` destination. No new runtime, no AI governance (M24), no audit export system.

## Entity

`ai_policy_rules` — scoped to `ai_streams.id`.

| Field | Values |
|-------|--------|
| `target` | `prompt`, `response` |
| `inspection_type` | `regex`, `keyword`, `pii`, `secret_pattern`, `sensitive_content` |
| `action_type` | `allow`, `deny`, `mask`, `redact`, `block` |

Audit-only actions are excluded; matched rules perform real enforcement.

## Flow

```
Prompt → Policy Check → Provider → Response Check → Client
```

Evaluation reuses `app/protection/policy_engine.py` (extended; no separate AI engine).

## Replay / Failover

| Event | Replay |
|-------|--------|
| Policy block (prompt or response) | **Not** eligible |
| Provider send failure (5xx, timeout, connect) | Eligible (existing replay engine) |

Policy blocks are not failover-eligible.

## RBAC

Reuse RBAC-lite. Capabilities: `ai_policy_read`, `ai_policy_operate`.

## Tests

Unit: policy evaluation, prompt inspection, response inspection. Integration: AI stream pipeline. E2E: prompt block, response mask. Replay/failover impact tests.
