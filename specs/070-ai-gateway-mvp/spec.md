# M14 AI Gateway MVP

**Status:** Outside Data Relay Control (Phase E) — separate-domain / historical reference only; not current Control implementation authority

Prompt inspection and policy enforcement before AI provider calls. No agents, RAG, streaming, or multi-provider orchestration.

## Pipeline (normative)

```text
Client → AI Gateway → Sensitive Detection → Classification → Protection
  → AI Gateway Policy → (Quarantine | Provider)
```

## Scope

- Tables: `ai_gateway_policies`, `ai_gateway_requests`
- APIs: `POST /api/v1/ai-gateway/evaluate`, `POST /api/v1/ai-gateway/chat`, `GET /api/v1/ai-gateway/summary`
- Mock provider only (no live OpenAI)
- Runtime UI: read-only AI Gateway panel under Operations → Runtime
- Observability: `delivery_logs` stage `ai_gateway_evaluation_complete`

## Policy actions

`allow`, `audit`, `block`, `quarantine` — conditions: `classification_level`, `sensitivity_class`.

## Non-goals

Agent, RAG, memory, tool calling, auto prompt rewrite, multi-provider, streaming, function calling.

## Constraints

Do not modify Classification, Quarantine, Replay, Failover, Dynamic Routing, Protection Engine, or Stream Policy Engine modules.
