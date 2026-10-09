# PF-9 Control opt-in Web TOTP MFA — source candidate

Status: **unreleased candidate**, stacked on pinned Foundation security-wheel Control PR #416. This describes source behavior and test-only verification; it is **not** permission to migrate a live DB, configure an account, set a secret, or deploy.

## Account behavior

- Default: MFA disabled per account. Existing password-only login works as before.
- Each signed-in local user, including Viewer and governance-only roles, may enroll *their own* account under **Administration → Admin settings → Authenticator (TOTP) MFA** (or the direct account Settings route for roles without an Administration hub shortcut). Enrollment requires the current password and a valid six-digit authenticator code within five minutes. This permission never grants other-account/platform administration.
- The authenticator QR is rendered entirely inside the product browser with the pinned qrcode library. TOTP URI/secret is **never sent to an external QR service**. A manual setup key is available. The browser does not persist the setup secret.
- Confirmation enables MFA, increments the user's JWT token epoch, and returns **eight** individual recovery codes **once**. The operator must save them offline. The browser does not persist these codes.
- At the next login, a valid password yields a three-minute, one-use **non-JWT** challenge, followed by TOTP or an unused recovery code. Access and refresh JWTs are created only after the second factor succeeds. To prevent persistent pre-auth token flooding, a maximum of five still-valid pending challenges is allowed per account, enforced transactionally across workers; expired proofs are pruned before issuing a new one, skipping locked proofs undergoing concurrent verification to avoid a row-lock deadlock.
- The per-account TOTP seed is AES-256-GCM encrypted with user-bound AAD; recovery codes are digested; and pending tokens are SHA-256 hashed. OTP counter reuse, recovery replay, expired/source-changed challenges, and concurrent re-verification fail closed. Enrollment password mistakes share the existing login source/account throttle; TOTP mistakes during either enrollment confirmation or login verification share one database-backed five-minute MFA lockout, consistently enforced across API workers.
- Enabling MFA revokes earlier access and refresh tokens. Enrollment confirmation locks and refreshes the user row before checking JWT epoch, so a concurrent refresh cannot make MFA reuse the same token version. Live authenticated product routes check current account epoch, role and second-factor assertion; simultaneous refreshes are serialized. Unknown persisted account roles are rejected at sign-in/refresh and during live JWT authority validation, never silently promoted to Administrator/Viewer. Logout-all invalidation rechecks the current role/epoch/MFA factor under a row lock, so an old access token cannot revoke a newer session by replay.
- An MFA-required account cannot downgrade itself to password-only login when the MFA encryption key is missing. A separately authenticated Administrator may reset a lost authenticator through **Administration → User Management → Reset MFA** for an enrolled account. The UI requires typing the exact target username and the Administrator's current password; the backend checks the Administrator JWT epoch/role/MFA state, re-verifies the password, locks both user rows, clears the target's encrypted seed/recovery codes and invalidates existing target sessions and pending challenges via an epoch bump. The target must enroll again. This is **source-only**: no live administrator, account, MFA setting or DB was reset, and a locked-out sole Administrator still requires approved out-of-band console recovery.

## Separate rollout requirements (not executed)

1. Approve the parent Foundation security wheel dependency and Control source PR; keep the release gates independent.
2. Review and migrate 20261009_0066_platform_mfa and 20261009_0067_mfa_lockout via an authorized **live-DB migration plan**. Only guarded gdc_pytest catalog DDL is run by tests.
3. Independently provision a strong, dedicated 32-byte hex GDC_MFA_ENCRYPTION_KEY_HEX using approved secret management. Do not set it in git, the current development host configuration, or any service as part of the source PR.
4. Preserve safe ingress: GDC_TRUST_PROXY_HEADERS is false by default; if enabled, specify actual trusted proxy peers in GDC_PROXY_FORWARD_TRUSTED_HOSTS. Do not trust arbitrary client-supplied X-Forwarded-For. The default explicit list is loopback-only. Host SSH and Web ingress IP ACLs are **out of scope**.
5. Before activation/release, run an actual browser feature reconciliation and two-user Full User E2E on the same candidate HEAD, then candidate freeze, exact-head CI and independent review, and obtain owner acceptance.

## Source-only validation

Run backend tests **only after** the local repo test database guard verifies TEST_DATABASE_URL is an isolated pytest catalog. Test fixtures may reset that catalog; never point them at the operator/application DB.

- Backend: PYTHONPATH=vendor/onprem-security/datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl:. python3 -m pytest -q tests/test_platform_user_totp_mfa.py
- Frontend: cd frontend && npm run test -- --run src/components/settings/admin-mfa-enrollment.test.tsx src/components/auth/platform-login-mfa.test.tsx
- Build: cd frontend && npm run build

Scripted/component checks are not a substitute for real-browser/Full User E2E or approval to deploy.
