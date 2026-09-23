"""Production-separation safety verification for the Dev Validation Lab.

These tests prove (at runtime, against a real DB + the real ``app.main`` lifespan
hook) that no [DEV VALIDATION] data is ever seeded when the process is in
production mode, even if every other dev-lab knob is flipped on. They are the
runtime counterpart to the static checks performed by
``scripts/validation-lab/verify-production-separation.sh``.

Scope intentionally excludes anything that would change StreamRunner / runtime /
checkpoint behavior — only the seeding entry points are exercised.
"""

from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.dev_validation_lab import runtime as lab_runtime
from app.dev_validation_lab.runtime_gates import dev_validation_runtime_enabled, is_production_app_env
from app.dev_validation_lab.seeder import lab_effective, seed_dev_validation_lab
from app.dev_validation_lab.validation_gates import lab_validation_should_execute
from app.streams.models import Stream
from app.validation.models import ContinuousValidation


def _count_lab_entities(db: Session) -> dict[str, int]:
    return {
        "connectors": db.query(Connector).filter(Connector.name.like("[DEV VALIDATION]%")).count(),
        "streams": db.query(Stream).filter(Stream.name.like("[DEV VALIDATION]%")).count(),
        "destinations": db.query(Destination).filter(Destination.name.like("[DEV VALIDATION]%")).count(),
        "validations_template_key": (
            db.query(ContinuousValidation)
            .filter(ContinuousValidation.template_key.isnot(None))
            .filter(ContinuousValidation.template_key.like("dev_lab_%"))
            .count()
        ),
    }


class TestRuntimeGatesProduction:
    @pytest.mark.parametrize("app_env", ["production", "prod", "PRODUCTION"])
    def test_dev_validation_runtime_disabled_in_production_by_default(
        self, monkeypatch: pytest.MonkeyPatch, app_env: str
    ) -> None:
        monkeypatch.setattr(settings, "APP_ENV", app_env, raising=False)
        monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", False, raising=False)
        assert is_production_app_env()
        assert dev_validation_runtime_enabled() is False

    def test_dev_validation_runtime_enabled_when_explicitly_opted_in_production(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "APP_ENV", "production", raising=False)
        monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", True, raising=False)
        assert dev_validation_runtime_enabled() is True

    def test_dev_validation_runtime_disabled_in_development_when_flag_false(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "APP_ENV", "development", raising=False)
        monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", False, raising=False)
        assert dev_validation_runtime_enabled() is False

    def test_lab_validation_skipped_in_production_without_lab_flag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.dev_validation_lab import templates as T

        monkeypatch.setattr(settings, "APP_ENV", "production", raising=False)
        monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", False, raising=False)
        row = ContinuousValidation(template_key=T.TK_S3_OBJECT_POLLING, enabled=True)
        assert lab_validation_should_execute(row) is False


class TestLabEffectiveMatrix:
    """``lab_effective()`` is the single source of truth for whether to seed."""

    @pytest.mark.parametrize(
        ("enable", "app_env", "expected"),
        [
            (False, "development", False),
            (False, "production", False),
            (False, "prod", False),
            (True, "production", False),
            (True, "prod", False),
            (True, "PRODUCTION", False),
            (True, "  Production  ", False),
            (True, "production-eu", True),
            (True, "development", True),
            (True, "staging", True),
            (True, "", True),
        ],
    )
    def test_lab_effective_matrix(
        self,
        monkeypatch: pytest.MonkeyPatch,
        enable: bool,
        app_env: str,
        expected: bool,
    ) -> None:
        monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", enable, raising=False)
        monkeypatch.setattr(settings, "APP_ENV", app_env, raising=False)
        assert lab_effective() is expected, (
            f"lab_effective() returned wrong value for enable={enable!r} APP_ENV={app_env!r}"
        )


class TestSeedSkippedInProduction:
    """Seeder direct entry point must refuse production, even with all flags on."""

    @pytest.mark.parametrize("app_env", ["production", "prod", "PRODUCTION", "Prod"])
    def test_seed_returns_skipped_in_production(
        self, monkeypatch: pytest.MonkeyPatch, db_session: Session, app_env: str
    ) -> None:
        monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", True, raising=False)
        monkeypatch.setattr(settings, "DEV_VALIDATION_AUTO_START", True, raising=False)
        monkeypatch.setattr(settings, "APP_ENV", app_env, raising=False)

        before = _count_lab_entities(db_session)
        result = seed_dev_validation_lab(db_session)

        assert result.get("skipped") is True
        assert "production" in str(result.get("reason", "")).lower() or "disabled" in str(
            result.get("reason", "")
        ).lower()

        db_session.expire_all()
        after = _count_lab_entities(db_session)
        assert after == before, f"production seed leaked lab data: before={before} after={after}"


class TestStartupOrchestratorProductionRefusal:
    """The lifespan-level entry point must short-circuit and never call seed/sync in production."""

    def test_startup_skips_seed_and_wiremock_sync_when_app_env_production(
        self, monkeypatch: pytest.MonkeyPatch, db_session: Session
    ) -> None:
        # Maximally permissive lab knobs — only APP_ENV should gate.
        monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", True, raising=False)
        monkeypatch.setattr(settings, "DEV_VALIDATION_AUTO_START", True, raising=False)
        monkeypatch.setattr(settings, "APP_ENV", "production", raising=False)

        seed_calls: list[object] = []
        sync_calls: list[object] = []
        trigger_calls: list[object] = []

        def _spy_seed(*a: object, **kw: object) -> dict[str, object]:
            seed_calls.append((a, kw))
            return {"skipped": False, "streams": 99}

        def _spy_sync(**kw: object) -> bool:
            sync_calls.append(kw)
            return True

        def _spy_trigger() -> None:
            trigger_calls.append(None)

        monkeypatch.setattr(lab_runtime, "seed_dev_validation_lab", _spy_seed, raising=True)
        monkeypatch.setattr(lab_runtime, "sync_wiremock_template_mappings", _spy_sync, raising=True)
        monkeypatch.setattr(lab_runtime, "_trigger_initial_validations", _spy_trigger, raising=True)

        before = _count_lab_entities(db_session)
        lab_runtime.run_dev_validation_lab_startup()
        db_session.expire_all()
        after = _count_lab_entities(db_session)

        assert seed_calls == [], "seed_dev_validation_lab must not be called in production"
        assert sync_calls == [], "sync_wiremock_template_mappings must not be called in production"
        assert trigger_calls == [], "_trigger_initial_validations must not be called in production"
        assert after == before, f"production startup leaked lab data: before={before} after={after}"

    def test_startup_skips_when_lab_disabled_even_in_development(
        self, monkeypatch: pytest.MonkeyPatch, db_session: Session
    ) -> None:
        monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", False, raising=False)
        monkeypatch.setattr(settings, "DEV_VALIDATION_AUTO_START", True, raising=False)
        monkeypatch.setattr(settings, "APP_ENV", "development", raising=False)

        seed_calls: list[object] = []
        sync_calls: list[object] = []

        monkeypatch.setattr(
            lab_runtime,
            "seed_dev_validation_lab",
            lambda *a, **kw: seed_calls.append((a, kw)) or {"skipped": False},
            raising=True,
        )
        monkeypatch.setattr(
            lab_runtime,
            "sync_wiremock_template_mappings",
            lambda **kw: sync_calls.append(kw) or True,
            raising=True,
        )

        before = _count_lab_entities(db_session)
        lab_runtime.run_dev_validation_lab_startup()
        db_session.expire_all()
        after = _count_lab_entities(db_session)

        assert seed_calls == []
        assert sync_calls == []
        assert after == before


class TestConfigDefaults:
    """Pydantic defaults must keep the lab off out-of-the-box, regardless of APP_ENV."""

    def test_default_app_env_is_not_production(self) -> None:
        from app.config import Settings  # local import to read class defaults, not env-loaded

        defaults = Settings.model_fields
        default_app_env = str(defaults["APP_ENV"].default).strip().lower()
        assert default_app_env not in {"production", "prod"}, (
            f"app.config.Settings.APP_ENV default must not be production (got {default_app_env!r})"
        )

    def test_lab_flags_default_off(self) -> None:
        from app.config import Settings

        defaults = Settings.model_fields
        assert defaults["ENABLE_DEV_VALIDATION_LAB"].default is False
        assert defaults["DEV_VALIDATION_AUTO_START"].default is False
        assert defaults["ENABLE_DEV_VALIDATION_S3"].default is False
        assert defaults["ENABLE_DEV_VALIDATION_DATABASE_QUERY"].default is False
        assert defaults["ENABLE_DEV_VALIDATION_REMOTE_FILE"].default is False
        assert defaults["ENABLE_DEV_VALIDATION_PERFORMANCE"].default is False


class TestDefaultComposeIsFullPlatform:
    """The root docker-compose.yml must not drift back to a Postgres-only partial startup."""

    def test_default_compose_extends_full_platform_services(self) -> None:
        from pathlib import Path

        compose_path = Path(__file__).resolve().parents[1] / "docker-compose.yml"
        assert compose_path.is_file(), f"missing {compose_path}"
        text = compose_path.read_text(encoding="utf-8")

        import yaml  # type: ignore[import-untyped]

        doc = yaml.safe_load(text) or {}
        services = doc.get("services") or {}
        required = {
            "postgres",
            "api",
            "frontend",
            "reverse-proxy",
            "gdc-wiremock-test",
            "gdc-webhook-receiver-test",
            "gdc-syslog-test",
        }
        assert required.issubset(set(services)), "docker compose up -d must start the full platform"
        for svc in required:
            assert (services[svc].get("extends") or {}).get("file") == "docker-compose.platform.yml"


class TestPlatformComposeSourceExpansionLabFlags:
    """Platform stack must keep source-expansion dev-validation rows visible by default."""

    def test_platform_compose_enables_source_expansion_lab_slice_env_keys(self) -> None:
        from pathlib import Path

        text = (Path(__file__).resolve().parents[1] / "docker-compose.platform.yml").read_text(encoding="utf-8")
        for flag in (
            "ENABLE_DEV_VALIDATION_S3",
            "ENABLE_DEV_VALIDATION_DATABASE_QUERY",
            "ENABLE_DEV_VALIDATION_REMOTE_FILE",
        ):
            assert f"{flag}: ${{{flag}:-true}}" in text, (
                f"docker-compose.platform.yml must keep {flag} enabled for the dev-validation visibility contract"
            )
        assert "ENABLE_DEV_VALIDATION_PERFORMANCE: ${ENABLE_DEV_VALIDATION_PERFORMANCE:-false}" in text
