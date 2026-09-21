# M31.2 — AI Stream UX Completion

**Status:** Outside Data Relay Control (Phase E) — separate-domain / historical reference only; not current Control implementation authority

## Goal

Complete AI Gateway operator UX to M30 parity: dedicated AI Stream wizard, detail page with W/W/W hero and issue rail, operator vocabulary.

## Scope

- AI Stream creation wizard (Provider → Traffic Route → Policy → Review)
- AI Stream detail page (Overview / Traffic / Issues / Settings)
- AI Stream hero (What happened? / Why? / What should I do?)
- AI Stream issue rail (reuse Stream Issue Rail pattern)
- Operator vocabulary (hide provider IDs, internal IDs, technical config)

## Non-goals

- Backend API changes
- DB schema changes
- Runtime changes
- New AI product features

## Patterns

Reuse M30.2 stream detail shell and M30.1 issue rail; adapt copy via `ai-stream-operator-vocabulary.ts` and `ai-stream-issue-context.ts`.

## Wizard orchestration

Wizard creates connector + `AI_PROXY_RECEIVER` source/stream, `AI_PROVIDER_POST` destination + route, default mapping `provider_request: $.ai.body`, then `POST /api/v1/ai-streams/`.

## Routes

- `/ai-gateway/streams/new` — wizard
- `/ai-gateway/streams/:aiStreamId` — detail
