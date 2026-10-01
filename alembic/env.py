from __future__ import annotations

import logging
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.config import settings
from app.database import Base
from app.database_url_resolution import apply_resolved_database_url_env

# Ensure model metadata is registered.
import app.checkpoints.models  # noqa: F401
import app.connectors.models  # noqa: F401
import app.connectors_registry.lifecycle_models  # noqa: F401
import app.destinations.models  # noqa: F401
import app.enrichments.models  # noqa: F401
import app.logs.models  # noqa: F401
import app.mappings.models  # noqa: F401
import app.routes.models  # noqa: F401
import app.route_transform.models  # noqa: F401
import app.sources.models  # noqa: F401
import app.streams.models  # noqa: F401
import app.runtime.models  # noqa: F401
import app.platform_admin.models  # noqa: F401
import app.backfill.models  # noqa: F401
import app.templates.models  # noqa: F401
import app.schema_observation.models  # noqa: F401
import app.protection.models  # noqa: F401
import app.dynamic_routing.models  # noqa: F401
import app.failover_routing.models  # noqa: F401
import app.replay.models  # noqa: F401
import app.quarantine.models  # noqa: F401
import app.ai_gateway.models  # noqa: F401
import app.ai_providers.models  # noqa: F401
import app.ai_streams.models  # noqa: F401
import app.ai_policy.models  # noqa: F401
import app.ai_audit.models  # noqa: F401
import app.ai_governance.models  # noqa: F401
import app.governance_policies.models  # noqa: F401
import app.governance_notifications.models  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# Prefer live env override (pytest sets TEST_DATABASE_URL → DATABASE_URL). Host shell
# maps compose-only hostnames (postgres) to the published loopback port when DNS fails.
_raw_db_url = os.environ.get("DATABASE_URL", "").strip() or settings.DATABASE_URL
_resolution = apply_resolved_database_url_env(_raw_db_url, context="alembic")
effective_db_url = _resolution.url or _raw_db_url
config.set_main_option("sqlalchemy.url", effective_db_url)
if _resolution.fallback_applied:
    logging.getLogger("alembic.runtime").warning(
        "%s",
        {
            "stage": "alembic_database_url_resolved",
            "source": _resolution.source,
            "original_host": _resolution.original_host,
            "resolved_host": _resolution.resolved_host,
            "resolved_port": _resolution.resolved_port,
        },
    )


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
