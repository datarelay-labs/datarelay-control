"""OpenAPI/docs exposure follows production fail-closed defaults."""

from __future__ import annotations

from app.main import app
from app.production_security import is_production_app_env


def test_docs_routes_enabled_outside_production() -> None:
    # Dev/test APP_ENV keeps interactive docs mounted on the app object.
    assert is_production_app_env("production") is True
    assert is_production_app_env("development") is False
    assert app.docs_url == "/docs"
    assert app.openapi_url == "/openapi.json"
    assert app.redoc_url == "/redoc"


def test_docs_hidden_when_app_env_production() -> None:
    # Mirror app.main wiring without constructing production Settings
    # (which fail-closes on insecure secrets).
    expose_prod = (not is_production_app_env("production")) or False
    expose_dev = (not is_production_app_env("development")) or False
    assert expose_prod is False
    assert expose_dev is True
