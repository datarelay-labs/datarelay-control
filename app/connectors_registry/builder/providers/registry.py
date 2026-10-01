"""Provider registry for AI translation backends."""

from __future__ import annotations

from typing import Iterable

from app.connectors_registry.builder.providers.base import AITranslationProvider


class UnknownProviderError(KeyError):
    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"unknown AI translation provider: {name!r}")


class ProviderRegistry:
    def __init__(self) -> None:
        self._by_name: dict[str, AITranslationProvider] = {}

    def register(self, provider: AITranslationProvider) -> None:
        key = provider.name.strip().lower()
        if not key:
            raise ValueError("provider.name must be non-empty")
        self._by_name[key] = provider

    def get(self, name: str) -> AITranslationProvider:
        key = (name or "").strip().lower()
        provider = self._by_name.get(key)
        if provider is None:
            raise UnknownProviderError(key)
        return provider

    def known(self) -> list[str]:
        return sorted(self._by_name.keys())

    def register_many(self, providers: Iterable[AITranslationProvider]) -> None:
        for provider in providers:
            self.register(provider)


def build_default_provider_registry() -> ProviderRegistry:
    from app.connectors_registry.builder.providers.fixture import (
        FixtureTranslationProvider,
        ManualTranslationProvider,
    )

    registry = ProviderRegistry()
    registry.register_many(
        [
            FixtureTranslationProvider(),
            ManualTranslationProvider(),
        ]
    )
    return registry
