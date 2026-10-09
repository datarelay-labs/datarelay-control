# G11 Control replay: product-owned effect ledger (staged development)

Status: **Source-only prerequisite, not mounted, not deployed, not a passing integration test.**
Owner authorization: 2026-10-09 staged Grant ↔ Control API/approval verification.
Authority: current Control Product Charter, Route Processing contracts, Grant G11
acceptance contract and Control Work Packet #419.

## Goal and boundaries

Control remains the product that owns its failed-delivery-log replay and destination
delivery. Grant remains the approval authority and provides the separately consumed
exact-action grant. Neither an email click nor callback receipt is permission to send.

This phase adds a **product-owned durable effect reservation** table and atomic
transitions to prevent a replay protected by Grant from being dispatched twice.
It does **not** change the existing `POST /api/v1/runtime/replay/delivery-log/{id}`
path, activate a protection policy, create a new API endpoint, authenticate Grant,
insert a user-visible setting, or send data.

The existing legacy replay API is still unprotected and can send twice. **Do not
describe this branch as ready for secure protected replay.**

## Actual product contract to be integrated later

- Replay scope is bound to a product-verified `delivery_log_id`, `route_id`,
  `destination_id`, stable `operation_key` and `execution_id`, canonical Grant
  request UUID and exact action SHA-256.
- Control must **independently** validate its current product configuration and
  authorization; the requester's operation metadata is not authority.
- A future authenticated Control executor must read approved, exact-action Grant
  state and obtain a fresh consumption proof. A failed, missing, revoked,
  held, denied, expired or replayed claim must never reach its destination
  adapter. The current code **does not perform this Grant API check**.
- Only after all Grant and Control policy checks succeed may the product ledger
  atomically arm one effect attempt under the exact binding.
- No bearer secret, personal data, raw email link, PIN or TOTP is recorded in the
  ledger. No arbitrary callback may trigger a replay.

## Persistence and state transitions

Schema: `grant_protected_replay_ledger`, append-only operation identity with
one attempt count and a uniqueness constraint on both operation key and execution ID.
Migration: `20261009_0071_grant_replay` after the Control active head
`20261006_0065_legacy_bridge`. Migration source is included for future package
qualification; **no migration was executed against the live or shared DB**.

- **RESERVED (attempts=0):** immutable Control operation registered. Neither a new
  reservation nor a duplicate registration authorizes a destination send.
- **UNKNOWN (attempts=1):** one atomic compare-and-swap has committed **before**
  dispatch. Crash-before-send, crash-during-send and lost-after-send outcomes
  all remain uncertain. The product must not retry the effect automatically.
- **DELIVERED (attempts=1):** the consuming product independently observed the
  result. A repeated request must not arm another effect.

`arm_after_external_grant_verification` is an *internal ledger method* whose
name encodes a future caller obligation, not proof of Grant authorization.
The positive `ONE_EFFECT_ATTEMPT_ARMED` result is **not** sufficient to send
without a currently validated Grant consume result and product operation guard.
It owns and commits a dedicated DB transaction before returning; callers
must not reuse an operator/session transaction.

`confirm_delivered_after_product_readback` is likewise a bookkeeping method,
not a receiver verifier. Failed or ambiguous sends remain UNKNOWN until actual
product/destination reconciliation. No automatic retry/double send is permitted.

## Compatibility, risk and operations

- Existing replay endpoint and its current users are unchanged by this stage.
  That also means they can still use its old unguarded path. A future opt-in
  **enforcement gate at the actual sending boundary** is mandatory; simply
  exposing a protected alternate endpoint would allow bypass.
- No new public API or credentials are defined here. Choosing provider auth,
  administrator policy, exact target/destination and deployment boundary occurs
  in the dedicated integration workstream, not from an untrusted callback.
- Migration must be applied only with approved Control release procedures, DB
  backups, testing and rollback. Do not run this migration on an operator or
  shared test catalog from this development workstream.
- Schema is additive; development source is isolated on
  `feat/g11-control-grant-replay-ledger`. The running Control build at
  `fc89dad` and latest main-v2 baseline `b45ad9d` are distinct; do not
  mix their acceptance evidence.

## Tests and evidence limits

`tests/test_g11_grant_replay_ledger.py` creates a fresh disposable SQLite
catalog under pytest's unique temporary directory. Scenarios cover new
reservations, duplicate/colliding identity, action/log/route/destination
mismatch, invalid payloads, crash uncertainty, one terminal delivery and
eight concurrent arm attempts with exactly one positive result.

These tests validate a portable SQLAlchemy state-machine precursor only. They
do **not** prove PostgreSQL transaction locks, migrations on a real Control
installation, actual authenticated Grant consume/results, or endpoint/product
and destination readback. The latter remain release-blocking G11 acceptance.

## Phase 2 remaining

1. Owner-approved **disposable** Control failed-delivery log and safe destination,
   with a current matching Grant integration and pinned Control test build.
2. Product-owned opt-in policy, guarded real replay send boundary, authenticated
   Grant claim/result contract, durable operation state and explicit fail-closed
   branch on absent/unverified claims. Legacy direct replay cannot be a bypass.
3. Isolated PostgreSQL migration and concurrency verification, crash-window
   recovery, precise audit redaction and operator runbook.
4. One independently observed destination effect plus Grant consume/result and
   Control checkpoint/ledger readback; denied/held/replay cases must send zero.
5. Separate external Stellar receiver and full two-human Grant acceptance.

Until all are met, **Control G11 M3 = WAITING_INTEGRATION**.
