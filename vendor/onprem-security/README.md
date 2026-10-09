# Control — Product Foundation On-Prem Python Wheel (PF-9 consumer C1)

**Status: isolated product consumer source only, not deployed/released.**
Work Packet: [#415](https://github.com/datarelay-labs/datarelay-control/issues/415).
Stacked on Control PF-5B [PR #412](https://github.com/datarelay-labs/datarelay-control/pull/412).

## Exact wheel provenance

- Package: `datarelay-onprem-security==0.10.0.dev0`
- Foundation source HEAD: `59b8199d6182e0bed2b25307736edb4dad32a246`
- Reviewed upstream: [Foundation Draft PR #86](https://github.com/datarelay-labs/datarelay-product-foundation/pull/86), stacked on PF-12C and prior security/operations Draft PRs.
- Wheel filename: `datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl`
- Byte count: 36,276
- Independently pinned SHA256:
  `6c7c4c8b425fb181e0c10c61aa7ec4ea47c24121379db2c5230251a3bdbc40db`
- Original source-tree digest is recorded in `candidate.json`. That JSON
  manifest is unsigned, so the **trusted expected hash is the fixed value
  in this code review and SHA256SUMS**, never automatically taken from the
  untrusted artifact to override a mismatch.

The exact wheel is vendored once as a *distribution artifact*, not by copying
security algorithms into the Control codebase. The API Docker build copies
this wheel before pip dependency install, verifies `sha256sum -c SHA256SUMS`
and loads it offline from `requirements.txt`. No mutable Foundation git
ref or runtime internet connection is needed.

## First real Control binding (this branch only)

`app.auth.password_policy.validate_new_platform_password`, called from
Control's real `/api/v1/auth/change-password` route, now delegates new password
validation to `datarelay_onprem_security.evaluate_new_password`. It preserves
the existing **Control 8-to-256 character compatibility** (Foundation's
future recommended 12-character default is not silently switched on) and
Control's existing forbidden `admin` plaintext. It additionally rejects
control/format characters, never echoing password values.

Existing bcrypt hashing, user sessions, JWT token version and account roles
stay exclusively Control-owned. The wheel's *other* APIs are only available
for future, separately reviewable native adapters. Importing the package
does NOT implement/activate optional TOTP MFA, SSH/Web UI management allowlists,
audit forwarding, key rotation, backup or offline upgrading. Their shared
status must remain unavailable until authoritative product paths and direct
user/browser/full E2E tests prove them. In particular, a FastAPI-only source
ACL would not protect nginx-served static Web UI or host sshd: **do not
advertise an Access ACL from this integration**.

## Validation and rollout gates

1. New `tests/test_onprem_foundation_wheel_control.py` verifies wheel
   hash/manifest/pip Docker binding and real Control password-validator
   delegation, legacy boundary/Unicode cases and secret-safe errors.
2. Focused auth/credential tests in a dedicated PostgreSQL **pytest-only**
   catalog where safe. No tests are allowed to truncate a live dev catalog.
3. Reproducible independent API Docker build (without deploying it) and
   exact HEAD CI/review.
4. Only after Control user Browser PASS → Full User E2E same HEAD → freeze →
   machine CI/hash/provenance/public smoke → owner release acceptance may
   this candidate become part of a live API image.
5. Later product MFA/IP ACL activation requires its own enrollment, 2-step
   pre-auth challenge, safe SSH host policy and rollback verified on isolated
   test environments. Previous platform safety blocks for Foundation TS
   admin modifications are not bypassed.

**No live Control DB, account password, SSH/firewall, backend process,
reverse proxy, production service or owner security policy is changed here.**
