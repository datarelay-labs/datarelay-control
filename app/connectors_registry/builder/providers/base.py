"""AI translation provider interface (provider-agnostic)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Mapping

from app.connectors_registry.builder.models import BoundedProviderRequest


class AITranslationProvider(ABC):
    """Provider interface: translate(request) -> StructuredTranslationResult dict."""

    name: str = "base"

    @abstractmethod
    def translate(self, request: BoundedProviderRequest) -> Mapping[str, Any]:
        """Return a schema-shaped StructuredTranslationResult mapping."""

        raise NotImplementedError
