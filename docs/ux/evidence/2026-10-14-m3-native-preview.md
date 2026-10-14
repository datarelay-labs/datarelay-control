# M3 native saved-Route preview — 2026-10-14

Status: SOURCE/NATIVE/COMPONENT VERIFIED; deployment, authenticated browser,
receiver comparison and complete WBS user acceptance remain open. UX_EXCLUSIVE_LOCK
is unchanged. Parent integration baseline: `3aaeb525` (M5-01 included unchanged).

## Scope and implementation

M3-03/04/05/06/09 reuse the existing Route pipeline and existing no-send endpoint.
A saved Route no longer first evaluates an unrelated caller draft or trusts a
hard-coded Webhook formatter. The native evaluator is invoked once and captures
Input, Mapping, Transform, Protection, Classification, Policy and saved-destination
formatted output. The existing ProcessingPreviewDock presents that evidence.
The duplicate metadata-only final-event panel is removed, not replaced with a
second evaluator or delivery engine.

Explicit preview mode cannot receive sender/log callbacks. Quarantine decisions
remain visible but no quarantine row is recorded. Tokenization requiring persistent
vault state returns an explicit 409 rather than persisting or inventing a token.
Inputs are capped at 1 MiB and captured stage evidence at 2 MiB. Standard secret
redaction follows known source credential values through renamed fields; display
projection never changes actual evaluator data. Broken saved rules return an
explicit stage error. Client results are bound to Route, Stream, sample, local
saved-revision identity and authenticated session; dirty edits, failed retries,
changed samples and late old responses cannot retain a successful result.

## Observed verification

- Initial saved-Route contract: 5 failures / 1 pass.
- Additional renamed-secret and invalid-rule error tests: 2 failures before fixes.
- Final native preview contract: 12/12 pass.
- Integrated native preview/formatter and affected Route runtime suite: 131/131 pass.
- Integrated frontend preview, Wizard, Route edit and M5 health tests: 40/40 pass.
- Scoped ESLint: pass. TypeScript plus Vite production build: pass.
- Source-of-truth validation: 9 current documents / 89 tracked specifications, pass.
- Actual Chromium launch: pass, 147.0.7727.15, after normal Playwright browser install.

Native tests used only the dedicated `gdc_pytest` catalog, never the populated
preview/operator catalog. No production, credential reset, host ACL change,
merge, release or receiver-success claim is included.

Private logs and the owned-file hash manifest are under
`/tmp/drcontrol-ux-m1-20261014/m3-integrated-*` and `m3-integration-source.json`.
The original shared source/diagnostic variants are retained unchanged; only the
11 owned M3 source/test files were integrated onto the latest remote baseline in
`/tmp/drcontrol-ux-m3-native-source-20261014`.

## Actual remaining gates and denials

The original M1 scheduler/fixture diagnostic was retried normally with
Remote_Desktop_Commander on the same dev-drcontrol device and was platform-denied
again. Native demo feeder/scheduler stay paused; live 5–20 EPS is NOT PASS.
A separate existing-service configuration and browser-login preparation request
was denied by the platform safety check before execution. Credentials were not
retrieved, changed or supplied to a browser by that request. No alternate
credential path or synthetic authenticated PASS was substituted.

Public M3 cutover has not been attempted after that preparation denial; do not
mistake this statement for a denied cutover or a globally inaccessible server.
The existing development service remains untouched by this continuation.

The full draft Route pipeline, server-side revision pinning across concurrent
configuration writes, remaining field-level warning/provenance coverage, persisted
tokenization proof and real browser/receiver reconciliation remain open. This
source slice does not complete M3 or any of the 57 full product acceptance rows.
