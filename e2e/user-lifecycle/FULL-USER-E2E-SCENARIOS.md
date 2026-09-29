# Data Relay Control Full User E2E — Automation Bridge

The canonical human Full User E2E execution contract is:

- `docs/FULL_USER_E2E_SCENARIOS.md`

This file intentionally does not duplicate that contract.

`e2e/user-lifecycle/` is the automated browser-first lifecycle implementation and supporting release evidence. It must preserve these hard rules:

- user-facing mutations are performed through Browser/UI;
- API/runtime/database reads may verify the result after the UI action;
- API mutation fallback cannot convert a blocked browser-required action into PASS;
- `STATIC_ONLY`, `PARTIAL`, and `BLOCKED` cannot satisfy a mandatory user journey;
- actual receiver evidence is required for delivery claims where a receiver exists;
- cleanup/orphan verification remains strict.

For a human `FULL_USER_E2E` request, execute `docs/FULL_USER_E2E_SCENARIOS.md`. For automated lifecycle execution, use this package's README and runner.
