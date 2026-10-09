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

## Staged exact Grant read/consume response validation (no network)

`app/runtime/grant_replay_claim.py` is a new pure, unmounted contract checker.
It does not make requests, store tokens, register API routes, or authorize a
destination effect. A future Control-owned executor must first obtain the
following server-authenticated responses over a separately approved scoped
Grant connection; **caller-provided dictionaries or callbacks are never proof
of approval**:

1. Authenticated `GET /api/v1/requests/{grant_request_id}` confirming
   `state=APPROVED`, exact request and trusted integration ID, and the
   product-derived immutable `action` / `action_hash`.
2. Authenticated `POST /api/v1/requests/{grant_request_id}/consume` with
   the stable product execution ID and action hash. Grant must return
   `committed=true`, `replay=false`, same request/execution ID and hash.
   A repeated claim returns `replay=true`; never send a second time.
3. Independently verify product operation/route/destination current authority
   and perform the product-ledger atomic arm. A positive contract match alone
   is **not** an execution permission; the checker explicitly returns
   `independently_authenticated=false, permits_effect=false`.

The proposed approval action, currently for **contract testing only**, is
`kind=datarelay.control.delivery_log.replay`,
`target=delivery-log/{id}`,
`parameters={log_id,route_id,destination_id}`, where IDs are immutable
positive integers read from actual Control state, not requester-provided JSON.
The operator must accept the final policy/action mapping before live use.

Action fingerprints match Grant's exact UTF-8
`sha256(json.dumps(action,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False))`.
Python value equality is NOT sufficient because `True == 1`; recomputing
the untrusted request action hash catches that discrepancy. Malformed,
nonfinite or secret-bearing fields, wrong integration, changed identity/action,
denial/hold/expiry, uncommitted or replayed responses fail closed.
Network timeout after the Grant consume POST is **ambiguous**; never retry
blindly or infer fresh approval from a stale GET.

The module is not mounted into the Control replay route and intentionally
does not create a Grant-to-Control authentication integration. Its future
authenticated transport must be independently qualified with approved
minimal scopes and avoid insecure HTTP, redirects and credential disclosure.

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

## Isolated actual API and loopback delivery E2E (2026-10-09)

This is an **owner-approved, separately executed development-only pilot** under
Control [Work Packet #422](https://github.com/datarelay-labs/datarelay-control/issues/422).
It adds `app/runtime/grant_replay_pilot.py` and an **opt-in executable test
harness** `scripts/testing/g11_grant_control_loopback_e2e.py`; the ordinary
Control `/api/v1/runtime/replay/delivery-log/{log_id}` router is NOT modified.
The test-only pilot refuses non-loopback or usual shared PostgreSQL port ranges
and checks a user-explicit sandbox flag. This is not a product permission path.

The execution uses the exact checked-out Grant development source
`c3ad02571609f57b6ce7bbf05e4da2ccfe4ba5a4` with a new disposable
SQLite store, synthetic requester/approver and independently scoped API tokens
(`request:create` for the producer; `request:read,grant:consume,result:write`
for Control). Grant runs as a real loopback HTTP server, with explicit
authenticated human approval calls. No real email/SaaS/customer credential.

Control uses a **new, single-use containerized PostgreSQL** database on a
random `127.0.0.1` port with its full Alembic migration chain, a synthetic
failed-delivery-log row, an immutable product route/destination binding and
the product-owned effect ledger. Only a uniquely named test-owned container
is eligible; the script must be invoked with a private sandbox root and
`G11_APPROVED_DISPOSABLE_E2E=yes`. Existing Control/PostgreSQL/Grant services,
customer destinations and running source worktrees stay untouched.

The Control pilot checks current log/route/destination state, the current
approved Grant request and a fresh authenticated exact-action Grant consume,
then commits **UNKNOWN/attempts=1** before calling Control's existing native
`replay_service.replay_delivery_log`. The webhook sender really performs
one HTTP POST to a newly bound loopback receiving server. After independent
receiver GET and unchanged Control checkpoint/operation-stage readback, the
pilot test records DELIVERED and uses authenticated Grant result API to
report `REPORTED_SUCCEEDED`.

The run explicitly verifies zero send on PENDING, HELD and DENIED; exact
action mismatch and insufficient producer-only `grant:consume` scope reject
before delivery; success delivers **one observed local HTTP event**;
repeat product ledger invocation and repeated Grant consume never deliver
again. A second approval/request cannot rearm a protected log because
the ledger now enforces **unique delivery_log_id** as well as unique
execution_id/operation_key. That uniqueness constraint was tested both on
disposable SQLite and the new isolated PostgreSQL migration.

**Evidence truthfulness:**
- The test is a real loopback HTTP + Control **native replay service** end-to-end
  flow. It does **not** exercise the Control operator-facing HTTP replay endpoint,
  which remains unguarded. The generic product replay API must not be described
  as Grant-protected, and full M3 external acceptance remains WAITING.
- A local receiving webhook is actual isolated network I/O, but is not a
  customer product destination. The independently read back local receiver
  is not a production/control-plane independent observer.
- The synthetic human account/API token belongs only to test Grant SQLite.
  No independent real two-person email/browser acceptance occurred, no actual
  Stellar receiver was involved, and no production credential was provisioned.
- Redacted receipt tracks actual Grant/Control source SHA, negative conditions,
  receiver count, ledger state and action/result readback; it contains no bearer
  token, SMTP secret or personal data. A fresh exact committed Control HEAD
  rerun is required before promoting a source test to an exact-HEAD evidence claim.

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
