# Control PF-11A — Governance notification transport: bounded native adoption

**Source:** Control B2–B6 roadmap #91, Foundation PF-11A
`docs/ONPREM_NOTIFICATION_DELIVERY.md`. This change is **source-only**;
it does not deploy SMTP, authorize outbound traffic, or qualify B4 / release.

## Observed starting defect

The Control M20.2 Governance notification dispatcher uses product-owned
`EmailSender` and `WebhookSender` interfaces. The previous module defaults
were `MockEmailSender` and `MockWebhookSender`, which reported success and
marked notification events SENT **without any network delivery** whenever
the administrator enabled a channel. The HTTP Test Send API could also
report success solely from these mock defaults.

## Bounded product-native correction

- **Default fail closed.** No email/Webhook transport is enabled implicitly.
  Unconfigured senders return False and do not create real network traffic.
  Explicit test doubles remain injectable in native tests.
  The production FastAPI lifespan previously overrode this default with
  `HttpWebhookSender` regardless of a verified Webhook egress/SSRF policy.
  Production startup now reasserts the unavailable sender; this was reproduced
  RED in a production-lifespan regression, then fixed and tested GREEN.
  Runtime Webhook network sending remains unavailable until a separately
  qualified egress boundary and explicit deployment authority exist.
- **SMTP opt-in.** To create a production-usable `SmtpEmailSender` the
  authorized product **deployment** must explicitly set the following
  server environment (not client-provided fields):

  | Setting | Requirement |
  | --- | --- |
  | `GDC_NOTIFICATION_SMTP_ENABLED` | Literal `true`; otherwise unavailable |
  | `GDC_NOTIFICATION_SMTP_HOST` | Required SMTP relay host |
  | `GDC_NOTIFICATION_SMTP_FROM` | Required simple mailbox identity |
  | `GDC_NOTIFICATION_SMTP_TLS_MODE` | `implicit_tls` (default) or `starttls`; plaintext unavailable |
  | `GDC_NOTIFICATION_SMTP_PORT` | Optional; defaults 465 (implicit) or 587 (STARTTLS) |
  | `GDC_NOTIFICATION_SMTP_TIMEOUT_SECONDS` | 1–30 seconds; defaults 10 |
  | `GDC_NOTIFICATION_SMTP_USERNAME` | Optional, must pair with password |
  | `GDC_NOTIFICATION_SMTP_PASSWORD` | Optional, must pair with username; secret never returned in API |

  The configuration is read at module initialization and can be refreshed
  only by an explicitly authorized process reload. Misconfiguration makes
  the sender unavailable; there is no downgrade to unverified TLS.
  The sender uses Python's certificate-checking SSL context and refuses
  header injection before opening a connection. Logs contain exception
  **types only**, never SMTP credentials or recipient/endpoint details.

- **Status truth.** An SMTP accept response is *relay acceptance*, not proof
  of inbox receipt. An HTTP Webhook 2xx similarly does not prove that the
  remote application processed the event. Test Send messages now distinguish
  that explicitly. Unavailable channels never claim a real send.
- **External event projection.** The original internal Governance event may
  retain structured diagnostic content, freeform operator comments and
  upstream failure strings. Outbound mail/Webhook now transmits only the
  event's type/severity/timestamp plus validated positive integer resource
  references (policy, replay event, Stream, Route and Destination IDs).
  Arbitrary event payload, freeform comments/messages, nested HTTP headers,
  API tokens, PEM/secret material and URL parameters never leave through
  notification payload serialization. The product-owned persisted event is
  unchanged, and operators can investigate full authorized evidence inside
  Control. Existing production integrations that relied on arbitrary
  notification payload fields must explicitly migrate to the bounded
  projection; they must not regain raw untrusted payload transmission.
- **Existing product ownership:** Control backend retains event/config
  data, role guards and message templates; Foundation defines shared
  policy, not a network client. No Foundation library was copied or
  upgraded by this change.

## Webhook SSRF/egress source boundary (not deployed)

The opt-in `HttpWebhookSender` now requires an exact DNS-host allowlist passed by
an authorized caller. It rejects HTTP, IP literals, credentials in URLs,
fragments, nonstandard ports, malformed hosts and unsafe control characters.
Every DNS response must contain only globally routable public addresses.
The HTTPS connection is pinned to a validated numeric address while TLS
verifies the original DNS hostname, preventing a second DNS lookup and DNS
rebinding between validation and connect. HTTP redirects are never followed.
Requests are bounded to 64 KiB and 30 seconds; logs contain exception types,
not URL paths, queries, tokens or event payloads. The default empty allowlist
rejects all attempts. The production startup **still installs only the
unavailable sender**: no network requests are enabled by this source change.
An authorized deployment policy, live egress qualification, runtime activation
and independent operator/browser acceptance remain separate gates.

## Durable outbox source path (opt-in, not scheduled)

Migration `20261012_0068_gov_outbox` adds a dedicated per-event,
per-channel delivery job table. Jobs are created within the originating
transaction, pin the configuration's revision timestamp and contain only an
internal event ID, channel, lease/retry state and bounded error type, **not**
raw Webhook URL, notification body, SMTP credential or other package secret.
The source-only `drain_outbox_once()` path commits PostgreSQL
`FOR UPDATE SKIP LOCKED` claims before sending, uses token-based CAS for
acknowledgements, supports expired-lease recovery and independently retries
email/Webhook jobs with bounded backoff (five attempts) and dead-letter state.
Notification-event SENT means all configured channel jobs succeeded;
failed/expired jobs remain observable. The read-only
`/api/v1/governance/notifications/health` contract additionally exposes
counts of pending, leased, retry-scheduled and dead-letter channel jobs,
without revealing receiver URLs, credentials, payloads or operator comments.
When outbox is OFF, these fields are zero and the legacy database is not
queried for an uninstalled outbox table. Default legacy dispatch is unchanged
unless `GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED=true` is explicitly set.

The in-process polling worker is integrated with the existing startup-readiness
and scheduler lifecycle, but it runs **only** when both
`GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED=true` **and**
`GDC_GOV_NOTIFICATION_WORKER_ENABLED=true` are explicitly configured.
Both default to OFF, and neither code path provisions credentials, enables
Webhook egress, performs live sends or applies a DB migration. Authorized
installation/configuration, real PostgreSQL concurrency/recovery evidence and
operator approval remain required before either flag is enabled in deployment. The transport is at-least-once:
crashes after remote acceptance but before acknowledgement may cause retries;
exactly-once downstream delivery is not claimed. Native source tests run in an
isolated in-memory DB with mocked senders and no external network calls.

## Safety and remaining product milestones

This bounded slice intentionally does **not** enable live service
configuration, update stored credentials, enable the gated notification
worker, run a real PostgreSQL migration, integrate the pinned PF-11A policy
wheel, activate the Webhook egress policy in production, or perform
an actual external send. The existing `HttpWebhookSender` is deliberately
**not** selected by default; it requires a later authorized integration
with a validated egress/allowlist policy.

Full PF-11A B4 acceptance still requires production qualification of the
source-only outbox claims, CAS, retry and dead-letter under real PostgreSQL
workers, owner-approved worker enablement, authenticated test send with audit
evidence, real TLS relay + Webhook integration,
tenant-safe redaction and observable recovery. The existing M20.2 event
SENT/FAILED model is not claimed as full PF-11A queue conformance.

A later approved isolated SMTP relay and Webhook endpoint may establish
real acceptance and timeout/rejection behavior. The implementation and
unit tests here involve **no real SMTP, HTTP delivery, production
secrets, customer messages, host policy or release**.

**User gates remain open:** browser-first Surface Reconciliation
(20 scenarios, 97 capability/control items) and same-final-HEAD two-user
Full User E2E, followed by owner release approval.
