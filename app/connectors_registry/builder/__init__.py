"""AI Connector Translator / Builder (M29.7).

Provider-agnostic Builder that turns evidence (harvested knowledge, OpenAPI,
samples, docs, script references) into untrusted Local/Imported Draft Source
Packs. Production network AI providers are optional / deferred.
"""

from app.connectors_registry.builder.models import (
    BuilderRequest,
    BuilderResult,
    BuilderStatus,
    BuilderTrustCandidate,
    DocumentationEvidence,
    OpenApiEvidence,
    SampleEvidence,
    ScriptReferenceEvidence,
    UserIntent,
)
from app.connectors_registry.builder.providers import (
    ProviderRegistry,
    UnknownProviderError,
    build_default_provider_registry,
)
from app.connectors_registry.builder.service import (
    AUTO_CREDENTIAL_CREATE,
    AUTO_INSTALL,
    AUTO_STREAM_CREATE,
    AUTO_STREAM_ENABLE,
    DEPENDENCY_INSTALL,
    PRODUCTION_AI_PROVIDER_IMPLEMENTED,
    SCRIPT_EXECUTION,
    SUBPROCESS_EXECUTION,
    TRUST_AUTO_PROMOTION,
    BuilderService,
    build_connector_draft,
)

__all__ = [
    "AUTO_CREDENTIAL_CREATE",
    "AUTO_INSTALL",
    "AUTO_STREAM_CREATE",
    "AUTO_STREAM_ENABLE",
    "BuilderRequest",
    "BuilderResult",
    "BuilderService",
    "BuilderStatus",
    "BuilderTrustCandidate",
    "DEPENDENCY_INSTALL",
    "DocumentationEvidence",
    "OpenApiEvidence",
    "PRODUCTION_AI_PROVIDER_IMPLEMENTED",
    "ProviderRegistry",
    "SCRIPT_EXECUTION",
    "SUBPROCESS_EXECUTION",
    "SampleEvidence",
    "ScriptReferenceEvidence",
    "TRUST_AUTO_PROMOTION",
    "UnknownProviderError",
    "UserIntent",
    "build_connector_draft",
    "build_default_provider_registry",
]
