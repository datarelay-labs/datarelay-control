# Shared deterministic business dataset

Fixed-seed generator (`seed=42`) emitting the same logical entities across transports.

## Generate

```bash
cd e2e
npm run lab:business-data:generate
# or
python3 lab/business-data/generate_business_dataset.py
```

## Seed into local fixtures

```bash
npm run lab:business-data:seed
```

Seeds:

- PostgreSQL `shared_business_*` (+ `shared_business_incremental`)
- MinIO `gdc-full-e2e/shared-business/*`
- SFTP `upload/shared-business/*`
- WireMock `/shared-business/*` stateful stubs
- Webhook sample event

## Tests

```bash
npm run lab:business-data:test
npm run lab:wiremock-stateful:test
npm run lab:checkpoint:test
npm run lab:cross-source:test
npm run lab:local-coverage:test
```

Canonical IDs (examples): `customer-001`, `order-001`, `product-001`.

Allowed cross-source differences: transport metadata, ordering (unless sorted),
webhook subset size, product-added source fields.
