# WordPress Basic Auth lab (TEST-ONLY)

Lightweight WP REST-compatible Basic Auth harness.

## Why not full WordPress+MySQL?

Full WordPress Apache + MySQL adds significant Docker memory. Under host
pressure this phase uses a WP REST-shaped service (~128MiB) that validates
real Data Relay `basic` auth against `/wp-json/wp/v2/*` (posts, pages, users,
comments, categories). WireMock Basic stubs remain protocol regression only.

## Start

```bash
docker compose -f e2e/real-apps/wordpress/docker-compose.yml up -d
```

Defaults: `wp-e2e-user` / `wp-e2e-pass` on `127.0.0.1:8088`.
