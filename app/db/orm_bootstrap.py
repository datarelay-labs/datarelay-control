"""Eager-import ORM models so string ``relationship()`` targets resolve.

Standalone scheduler (and other non-FastAPI entrypoints) do not load every
router module. Retention / backfill paths can otherwise configure mappers while
``Stream`` / ``Connector`` / related classes are still unregistered, which
surfaces as recurring ``InvalidRequestError`` on the retention tick.
"""

from __future__ import annotations

from sqlalchemy.orm import configure_mappers


def ensure_orm_models_registered() -> None:
    """Import relationship-linked models, then configure mappers once."""

    # Import order is not load-bearing once all names exist; group by domain.
    from app.backfill import models as _backfill_models  # noqa: F401
    from app.checkpoints import models as _checkpoint_models  # noqa: F401
    from app.connectors import models as _connector_models  # noqa: F401
    from app.destinations import models as _destination_models  # noqa: F401
    from app.enrichments import models as _enrichment_models  # noqa: F401
    from app.mappings import models as _mapping_models  # noqa: F401
    from app.route_transform import models as _route_transform_models  # noqa: F401
    from app.routes import models as _route_models  # noqa: F401
    from app.sources import models as _source_models  # noqa: F401
    from app.streams import models as _stream_models  # noqa: F401
    from app.validation import models as _validation_models  # noqa: F401

    configure_mappers()
