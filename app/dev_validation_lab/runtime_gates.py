"""Runtime gates for dev-validation lab activity (streams, continuous validation)."""

from __future__ import annotations

from app.dev_validation_lab.templates import LAB_NAME_PREFIX

_VISIBLE_E2E_PREFIX = "[DEV E2E] "
# Cross-product / matrix harness streams — executed via run-once or webhook ingest, not the poller.
_FULL_E2E_HARNESS_PREFIX = "[FULL E2E]"


def is_production_app_env(app_env: str | None = None) -> bool:
    """True when ``APP_ENV`` is production/prod (case-insensitive)."""

    from app.config import settings

    env = (app_env if app_env is not None else getattr(settings, "APP_ENV", "") or "").strip().lower()
    return env in {"production", "prod"}


def dev_validation_runtime_enabled() -> bool:
    """Whether lab streams and ``dev_lab_*`` validations may execute in this process.

    ``ENABLE_DEV_VALIDATION_LAB=false`` keeps existing ``[DEV VALIDATION]`` and
    ``[DEV E2E]`` rows out of the scheduler in every environment, including
    development. Production seeding remains separately refused by ``lab_effective()``.
    """

    from app.config import settings

    return bool(getattr(settings, "ENABLE_DEV_VALIDATION_LAB", False))


def stream_name_is_dev_validation_lab(name: str | None) -> bool:
    return str(name or "").startswith(LAB_NAME_PREFIX)


def stream_name_is_visible_e2e(name: str | None) -> bool:
    return str(name or "").startswith(_VISIBLE_E2E_PREFIX)


def is_lab_fixture_stream(name: str | None) -> bool:
    """True for ``[DEV VALIDATION]`` or ``[DEV E2E]`` catalog streams (lab data generation)."""

    return stream_name_is_dev_validation_lab(name) or stream_name_is_visible_e2e(name)


def stream_name_is_full_e2e_harness(name: str | None) -> bool:
    """True for ``[FULL E2E]`` harness streams (cross-product / matrix run-once ownership).

    Isolated lab stacks that need scheduler-owned scenarios (``runtime__scheduler__*``)
    must use a distinct ``GDC_E2E_NAME_PREFIX`` (for example ``[OSS V1 E2E]``) so the
    poller still executes those streams. Harness run-once races are handled in the
    Full E2E driver (idle wait / RUN_ALREADY_ACTIVE retry), not by skipping every
    prefixed stream.
    """

    return str(name or "").startswith(_FULL_E2E_HARNESS_PREFIX)


def is_run_once_harness_stream(name: str | None) -> bool:
    """Streams the in-process scheduler must not poll — harness owns execution."""

    return stream_name_is_full_e2e_harness(name)


__all__ = [
    "dev_validation_runtime_enabled",
    "is_lab_fixture_stream",
    "is_production_app_env",
    "is_run_once_harness_stream",
    "stream_name_is_dev_validation_lab",
    "stream_name_is_full_e2e_harness",
    "stream_name_is_visible_e2e",
]
