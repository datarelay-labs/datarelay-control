# Control PF-9 management ingress ACL — preview-only source adapter

Status: **PREVIEW ONLY / NOT ENABLED / NOT DEPLOYED**. This document describes
code on the dedicated Management ACL source branch, **not** an active SSH,
firewall, reverse-proxy, login-page, or management API allowlist.

## Security boundary

The shared Product Foundation wheel `datarelay_onprem_security` is the authority
for IPv4/IPv6 CIDR canonicalization, entry expiry, source matching, and
self-lockout advisory evaluation. Control currently does **not** have a
privileged host adapter that can apply a transactional SSH policy alongside
Web UI **and** management API proxy restrictions.

A **source-only Administrator preview panel** is displayed at
**Administration → Admin settings → Management access IP allowlist**. The form
accepts draft Web UI/API and host SSH IPv4/IPv6 ranges and displays the
server-side diagnostic result with visible blockers. It has only a **Preview
proposal** action, never Save/Apply/Enable. Viewer/non-administrator roles
cannot submit a preview. Draft values are not persisted in browser storage or
host configuration.

The read-only administrator diagnostic endpoint is
`POST /api/v1/admin/management-access/preview`. This endpoint:

- Requires a currently authenticated Administrator JWT; never uses the
  anonymous development header or a caller-submitted role as authority.
- Accepts proposed `web` and `ssh` policies, each containing `enabled`,
  `revision` and `sources: [{cidr, name, expires_at}]`; optional
  `rollback_seconds` is restricted to 60–3600 seconds.
- Rejects unrestricted CIDRs (`0.0.0.0/0`, `::/0`), malformed networks,
  duplicate canonical CIDRs, or an enabled policy with no entries.
- Uses only the framework-verified `request.client.host` to describe an
  observed API peer; does **not** parse arbitrary X-Forwarded-For or Forwarded
  request headers as authorization evidence. When behind the reverse proxy,
  the observed API peer is **not independently proven** to equal the public
  Web/SSH client; this API alone cannot validate an entire management ingress.
- Always reports `mode=PREVIEW_ONLY`, `apply_available=false`,
  `ssh_enforcement_available=false`, and
  `web_enforcement_available=false`. The permanent blockers include
  unverified external console, missing SSH host control/rollback,
  missing atomic NGINX + management API enforcement, and an unverified public
  Web client identity.

**No apply/save/enable endpoint is exposed.** Proposed CIDRs are never written
to platform settings, environment variables, proxy configuration, iptables,
nftables, firewall, or sshd. A positive `web_source_matches` is **not** an
authorization to apply a policy.

## Host integration requirements before product activation

1. Verify a physically reachable, authenticated out-of-band management or
   emergency console; decide who can recover a self-lockout without relying on
   the same blocked SSH or Web paths.
2. Implement host SSH enforcement with an idempotent, privilege-separated
   adapter. Its input must be the exact policy revision, not arbitrary shell
   commands; prove the target sshd service/port(s), IPv4/IPv6 handling,
   configuration syntax validation, safe rollback and existing session preservation.
3. Implement **combined NGINX Web UI and management API** enforcement at the
   actual public ingress, including login/static assets, HTTP/HTTPS listeners,
   explicit proxy trusted-peer resolution, anti-spoofing, correct remote/loopback
   semantics and required infrastructure health exceptions. An API-only middleware
   is not sufficient to claim a Web UI allowlist.
4. Install a durable, independent automatic rollback timer *before* apply,
   atomically stage/test configuration, apply without losing emergency access,
   verify externally, require an explicit owner acknowledgement before committing
   the new revision, and audit every transition and timeout rollback.
5. Define a locked-down break-glass procedure for a locked-out sole administrator.
   Never enable the feature by default; production and existing host state are
   unchanged until separately authorized.
6. Execute real Browser Reconciliation and two-user Full User E2E on the same
   exact product HEAD, including permitted and denied IPv4/IPv6 clients, before
   candidate freeze/CI/release acceptance.

## Source-only validation

`PYTHONPATH=vendor/onprem-security/datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl:. python3 -m pytest -q tests/test_management_acl_preview.py`

Web companion:
`cd frontend && npm run test -- --run src/components/settings/admin-management-acl-preview.test.tsx`

The suites assert default-off source-only preview, strict role/auth
checks, spoof resistance, failure on invalid and broad CIDRs, a preview-only
browser action with no fake Apply/Save route, and honest unavailable
enforcement status. They do **not** demonstrate actual SSH/NGINX packet
filtering, source-IP enforcement, rollback, or user E2E.
