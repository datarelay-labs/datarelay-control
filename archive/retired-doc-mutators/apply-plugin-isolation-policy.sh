#!/usr/bin/env bash
set -euo pipefail

cd ~/gdc-platform

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=".backup/plugin-isolation-policy-${TS}"
mkdir -p "$BACKUP_DIR"

FILES=(
  ".specify/memory/constitution.md"
  "specs/001-core-architecture/spec.md"
  "docs/master-design.md"
)

for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "missing: $f"
    exit 1
  fi
  mkdir -p "$BACKUP_DIR/$(dirname "$f")"
  cp "$f" "$BACKUP_DIR/$f"
done

python3 <<'PY'
from pathlib import Path

updates = {
    ".specify/memory/constitution.md": {
        "marker": "PLUGIN_ADAPTER_ISOLATION_POLICY",
        "content": """
---

# PLUGIN_ADAPTER_ISOLATION_POLICY

## Purpose

Generic Data Connector Platform must support new Source, Auth, Destination, and Stream capabilities without destabilizing existing working connectors.

The runtime core must remain stable. New integrations must be added through isolated plugin or adapter modules.

## Mandatory Rules

1. Runtime Core must only orchestrate execution.
2. Vendor-specific logic must not be implemented inside StreamRunner.
3. Source-specific logic must not be implemented inside StreamRunner.
4. Auth-specific logic must not be implemented inside StreamRunner.
5. Destination-specific logic must not be implemented inside StreamRunner.
6. New Source/Auth/Destination types must be implemented as new adapter or strategy files.
7. Existing working adapters must not be modified unless the task explicitly requires a bug fix in that adapter.
8. Adding a new type must be additive-first.
9. Registry-based dispatch must be used instead of large if/elif chains.
10. Existing regression tests for Basic, Bearer, Vendor JWT Exchange, Runtime, Route, Delivery, and Checkpoint behavior must continue to pass.

## Forbidden Patterns

The following patterns are forbidden in runtime core code:

~~~text
if auth_type == "..."
if source_type == "..."
if vendor == "..."
if destination_type == "..."
~~~

These decisions must be delegated to registries, adapters, or strategy classes.

## Required Architecture

~~~text
StreamRunner
  -> SourceAdapterRegistry
  -> SourceAdapter.execute()
  -> Mapping Engine
  -> Enrichment Engine
  -> DestinationAdapterRegistry
  -> DestinationAdapter.send()
  -> Checkpoint Service
~~~

Authentication must follow the same rule:

~~~text
AuthStrategyRegistry
  -> selected AuthStrategy.apply()
~~~

## Cursor Enforcement

When Cursor adds a new integration such as S3, Database Query, Webhook Receiver, OAuth2, or a vendor-specific auth flow, it must:

~~~text
- create a new adapter/strategy file
- register it in the proper registry
- add focused tests for the new adapter
- run existing regression tests
- avoid unrelated file changes
- avoid changing existing working connector behavior
~~~
"""
    },
    "specs/001-core-architecture/spec.md": {
        "marker": "PLUGIN_ADAPTER_EXTENSION_ARCHITECTURE",
        "content": """
---

# PLUGIN_ADAPTER_EXTENSION_ARCHITECTURE

## Core Rule

New connector capabilities must be added through plugin-style adapters, not by modifying runtime orchestration logic.

Runtime Core includes:

~~~text
StreamRunner
Scheduler
Checkpoint pipeline
Mapping pipeline
Enrichment pipeline
Routing pipeline
Delivery transaction flow
~~~

Runtime Core must remain source-agnostic, auth-agnostic, destination-agnostic, and vendor-agnostic.

## Source Adapter Model

~~~text
app/sources/adapters/
  base.py
  registry.py
  http_api.py
  s3.py
  database.py
  webhook_receiver.py
~~~

Expected dispatch:

~~~text
adapter = SourceAdapterRegistry.get(source_type)
events = adapter.fetch(stream, source, checkpoint)
~~~

## Auth Strategy Model

~~~text
app/connectors/auth/
  base.py
  registry.py
  basic.py
  bearer.py
  api_key.py
  vendor_jwt_exchange.py
  s3_access_key.py
  s3_iam_role.py
~~~

Expected dispatch:

~~~text
strategy = AuthStrategyRegistry.get(auth_type)
prepared_request = strategy.apply(request, connector_auth)
~~~

## Destination Adapter Model

~~~text
app/destinations/adapters/
  base.py
  registry.py
  syslog_udp.py
  syslog_tcp.py
  webhook_post.py
~~~

Expected dispatch:

~~~text
adapter = DestinationAdapterRegistry.get(destination_type)
result = adapter.send(destination, formatted_event)
~~~

## Extension Rule

Adding a new Source/Auth/Destination type must not require changes to:

~~~text
- StreamRunner business flow
- checkpoint update rules
- mapping/enrichment order
- route failure policy semantics
- existing HTTP API polling behavior
- existing Basic/Bearer/Vendor JWT auth behavior
~~~

Only the following changes are normally allowed:

~~~text
- new adapter/strategy file
- registry registration
- schema enum/type addition if required
- migration if persistence model requires it
- focused tests
- UI option addition if required
~~~
"""
    },
    "docs/master-design.md": {
        "marker": "PLUGIN_ADAPTER_ISOLATION_DESIGN",
        "content": """
---

# PLUGIN_ADAPTER_ISOLATION_DESIGN

## Design Goal

The platform must allow new integrations such as S3, Database Query, Webhook Receiver, OAuth2, Kafka, or vendor-specific APIs without breaking already working HTTP/API/JWT connectors.

Therefore, all new integration logic must be isolated into plugin-style adapters.

## Required Backend Layout

~~~text
app/sources/adapters/
  base.py
  registry.py
  http_api.py
  s3.py
  database.py
  webhook_receiver.py

app/connectors/auth/
  base.py
  registry.py
  basic.py
  bearer.py
  api_key.py
  vendor_jwt_exchange.py
  s3_access_key.py
  s3_iam_role.py

app/destinations/adapters/
  base.py
  registry.py
  syslog_udp.py
  syslog_tcp.py
  webhook_post.py
~~~

## Runtime Responsibility

StreamRunner must only control the common pipeline:

~~~text
lock
rate limit
source adapter execution
event extraction
mapping
enrichment
formatting
routing
destination adapter execution
checkpoint update after successful delivery
structured logs
single transaction commit
~~~

StreamRunner must not contain vendor-specific, source-specific, auth-specific, or destination-specific implementation details.

## Additive Extension Policy

When adding a new integration type:

~~~text
1. Add a new adapter or strategy file.
2. Register the new type in the appropriate registry.
3. Add focused tests for the new type.
4. Run existing regression tests.
5. Do not modify existing working adapters unless explicitly required.
6. Do not change checkpoint, route, delivery, or transaction semantics.
~~~

## Cursor Safety Rule

Cursor prompts must explicitly state:

~~~text
Follow PLUGIN_ADAPTER_ISOLATION_POLICY.
Implement the requested integration as an isolated adapter/strategy.
Do not modify unrelated existing adapters.
Do not add source/auth/vendor-specific branching to StreamRunner.
Do not change existing working connector behavior.
~~~
"""
    },
}

for file_name, item in updates.items():
    path = Path(file_name)
    text = path.read_text(encoding="utf-8")
    if item["marker"] in text:
        print(f"skip: {file_name}")
        continue
    path.write_text(text.rstrip() + "\n" + item["content"].strip() + "\n", encoding="utf-8")
    print(f"updated: {file_name}")
PY

grep -RniE "PLUGIN_ADAPTER_ISOLATION_POLICY|PLUGIN_ADAPTER_EXTENSION_ARCHITECTURE|PLUGIN_ADAPTER_ISOLATION_DESIGN" \
  .specify/memory/constitution.md \
  specs/001-core-architecture/spec.md \
  docs/master-design.md

git diff -- .specify/memory/constitution.md specs/001-core-architecture/spec.md docs/master-design.md

echo "backup: $BACKUP_DIR"
