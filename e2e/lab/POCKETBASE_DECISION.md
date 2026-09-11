# PocketBase evaluation (local E2E coverage expansion)

## Decision: REJECT_REDUNDANT

### Why not adopt

Local real-protocol coverage already provided by:

| Need | Existing coverage |
|------|-------------------|
| Session cookie auth | Frappe harness (REAL) |
| HTTP Basic | WordPress harness (REAL) |
| OAuth2 client credentials | Keycloak (REAL) + WireMock regression |
| Deterministic REST CRUD / pagination / errors | WireMock stateful scenarios |
| Dynamic SQL-backed rows | PostgreSQL fixture + shared business seed |
| Token-protected HTTP JSON | Keycloak protected resource lab |

PocketBase would add another always-on (or on-demand) binary without unique auth/protocol
semantics beyond what Frappe + WordPress + WireMock + Postgres already exercise against
**current** Data Relay capabilities.

### Revisit if

- Product adds a first-class PocketBase connector, or
- We need a single mutable SQLite-backed REST app for operator demos beyond WireMock state machines.
