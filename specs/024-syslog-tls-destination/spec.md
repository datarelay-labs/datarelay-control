# Syslog TLS Destination

## Goal

Allow GDC streams/routes to securely deliver runtime log events over Syslog
TCP+TLS (RFC5425-style) in addition to the existing UDP and plain TCP syslog
delivery modes. This is for runtime log delivery only and must not change the
browser HTTPS reverse proxy described in spec 021.

## Scope

In scope:

- New destination type `SYSLOG_TLS`.
- Destination configuration fields for TLS material and verification mode.
- Runtime sender that wraps a TCP socket with `ssl.SSLContext`.
- Connectivity probe that performs the TLS handshake and reports negotiated
  protocol/cipher and verification errors.
- UI surface for create/edit, badges, and operational metadata.
- Backend and frontend tests covering verification modes and retry compatibility.

Out of scope (do not implement):

- DTLS over UDP.
- Mutual TLS auto-enrollment.
- Certificate generation UI.
- Syslog over QUIC.
- Changes to the browser-facing nginx reverse proxy in spec 021.

## Destination Types (spec 004 §Destination Types)

Supported `destination_type` values for syslog delivery:

- `SYSLOG_UDP`
- `SYSLOG_TCP`
- `SYSLOG_TLS` (new)

`SYSLOG_TLS` is treated as a TCP-based protocol with TLS wrapping; the wire
framing remains the existing newline-terminated JSON line per event.

## TLS Configuration Fields

`destinations.config_json` keys for `SYSLOG_TLS`:

- `host` (string, required)
- `port` (int, required)
- `tls_enabled` (bool, must be `true` for `SYSLOG_TLS`)
- `tls_verify_mode` (string enum, default `strict`)
  - `strict` — requires CA verification + hostname check
  - `insecure_skip_verify` — disables verification, used only for lab/local testing
- `tls_ca_cert_path` (optional, absolute path to CA bundle PEM)
- `tls_client_cert_path` (optional, absolute path to client certificate PEM)
- `tls_client_key_path` (optional, absolute path to client private key PEM)
- `tls_server_name` (optional SNI override; defaults to `host`)
- `connect_timeout` (float seconds, default `5`)
- `write_timeout` (float seconds, default `5`)

Any non-syslog destination type that includes `tls_*` keys must fail validation.

## Sender Behavior (spec 002 + spec 004 + constitution)

`SyslogSender` learns a third protocol selector, `tls`, in addition to `udp` and
`tcp`:

1. `resolve_syslog_protocol` returns `tls` when `destination_type` is
   `SYSLOG_TLS`.
2. The TLS branch:
   - Builds an `ssl.SSLContext` based on `tls_verify_mode` and optional CA bundle.
   - Loads optional client certificate/key for mutual auth.
   - Wraps the TCP socket created via `socket.create_connection`.
   - Passes `server_hostname` from `tls_server_name` (or `host`) for SNI.
   - Sends the same per-event newline-terminated JSON payload as `SYSLOG_TCP`.
3. Connection, handshake, or verification failures raise `DestinationSendError`,
   identical to the existing TCP failure semantics.

The sender must never change StreamRunner transaction semantics, checkpoint
ordering, or route retry/failure policies.

## Connectivity Probe

`run_destination_connectivity_probe("SYSLOG_TLS", config)` performs:

1. TCP connect using `connect_timeout`.
2. TLS handshake with the resolved verification mode and SNI.
3. Send a single test syslog line.
4. Capture negotiated protocol version and cipher suite when available.
5. Return human-readable error messages for common failure cases:
   - cert verify failed (untrusted CA)
   - hostname mismatch
   - expired certificate
   - connection timeout

The probe never persists runtime checkpoints or delivery logs and never changes
runtime delivery state.

## UI / Visibility

Destination form must:

- Offer `SYSLOG_TLS` in the type select.
- Show TLS section only when `SYSLOG_TLS` is selected.
- Show a warning when `tls_verify_mode = insecure_skip_verify` is selected.
- Validate required host/port.

Destination detail/list must:

- Render a `SYSLOG_TLS` badge.
- Show `tls_verify_mode` and TLS test metadata (`negotiated_tls_version`,
  `cipher`) when available.

Logs/Runtime visibility must:

- Display TLS handshake failures readably (no raw tracebacks in UI).
- Continue to show latency and retry metrics through existing pipelines.

## Retry / Failure Compatibility

`SYSLOG_TLS` failures must behave exactly like existing destination failures:

- `route_send_failed` is staged when delivery fails.
- `RETRY_AND_BACKOFF` retries through the same path.
- `PAUSE_STREAM_ON_FAILURE` pauses the stream.
- `DISABLE_ROUTE_ON_FAILURE` disables the route.
- Checkpoint advances only when all required routes succeed (existing rule).

## Tests

Backend:

- TLS handshake success against a self-signed cert with strict verification when
  CA path is provided.
- TLS handshake success with `insecure_skip_verify` against a self-signed cert.
- Hostname mismatch failure under `strict`.
- Expired cert failure under `strict`.
- Retry then success when the first TLS attempt fails.
- Checkpoint unchanged when the entire TLS delivery fails (with
  `PAUSE_STREAM_ON_FAILURE`).
- `POST /destinations/{id}/test` for `SYSLOG_TLS`.

Frontend:

- Destination form renders TLS fields only for `SYSLOG_TLS`.
- TLS field validation (required host/port; verify mode select).
- Insecure warning render when verify mode is `insecure_skip_verify`.
- Destination detail rendering with TLS badge and metadata.

## Forbidden / Not Touched

- Browser HTTPS reverse proxy behavior (spec 021).
- StreamRunner ownership rules and commit semantics.
- Checkpoint commit-after-delivery semantics (spec 002).
- Validation Lab isolation behavior.
- Runtime Operations dashboard semantics.
