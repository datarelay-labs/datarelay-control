# TEST-ONLY Keycloak for real Data Relay `oauth2_client_credentials`

ON_DEMAND lab (not production). Observed memory ≈ **384MiB / 768MiB** limit after ready
(~2–4 minutes cold start). Prefer starting only when validating OAuth.

## Start / stop

```bash
cd e2e
npm run real-apps:keycloak:up
# wait until realm is ready:
curl -sf http://127.0.0.1:8089/realms/gdc-e2e/.well-known/openid-configuration

npm run real-apps:keycloak:test
npm run real-apps:keycloak:down
```

## Clients (realm `gdc-e2e`)

| client_id | secret | purpose |
|-----------|--------|---------|
| `gdc-e2e-oauth-client` | `gdc-e2e-oauth-secret` | valid confidential client (service accounts) |
| `gdc-e2e-oauth-disabled` | `gdc-e2e-disabled-secret` | disabled client → 401 |
| `gdc-e2e-oauth-scoped` | `gdc-e2e-scoped-secret` | optional scope experiments |

Token URL (Docker network — use this from Data Relay / platform-api):

```text
http://gdc-keycloak-e2e:8089/realms/gdc-e2e/protocol/openid-connect/token
```

Protected resource:

```text
http://gdc-keycloak-resource-lab:8090/business/customers
```

Data Relay must use **HTTP Basic** client auth + `grant_type=client_credentials`
(form-urlencoded) — matches product `OAuth2ClientCredentialsStrategy`.

## Notes

- Host-issued tokens (`http://127.0.0.1:8089/...`) use issuer `127.0.0.1` and will fail
  resource introspection (Keycloak hostname). Always acquire tokens via the Docker
  hostname for the full path, or run `keycloak_oauth_e2e.py` (does this for you).
- Auth code / PKCE are **NOT_IMPLEMENTED** in product — do not enable those flows here.
- WireMock Okta stubs remain for regression; Keycloak is the real IdP proof.
