"""PF-11A regression: product startup may not silently enable unguarded Webhooks."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.governance_notifications.webhook_sender import (
    HttpWebhookSender,
    UnavailableWebhookSender,
    get_webhook_sender,
    reset_webhook_sender,
)


@pytest.fixture(autouse=True)
def _reset_unconfigured_sender():
    reset_webhook_sender()
    yield
    reset_webhook_sender()


@pytest.mark.parametrize("environment", ["production", "prod"])
def test_production_lifespan_cannot_activate_unreviewed_webhook_egress(
    monkeypatch, environment: str,
):
    import app.main as main

    class PassiveSubsystem:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            pass

        def stop(self):
            pass

    monkeypatch.setattr(main.settings, "APP_ENV", environment)
    monkeypatch.setattr(main, "ensure_production_security_settings", lambda _settings: None)
    monkeypatch.setattr(
        main,
        "evaluate_startup_readiness",
        lambda: SimpleNamespace(schema_ready=False, scheduler_active=False),
    )
    monkeypatch.setattr(main, "bootstrap_registry", lambda: None)
    monkeypatch.setattr(main, "log_startup_readiness_summary", lambda *_args, **_kwargs: None)
    for name in (
        "Scheduler",
        "ContinuousValidationScheduler",
        "OperationalRetentionScheduler",
        "PartitionMaintenanceScheduler",
        "RuntimeSnapshotScheduler",
        "RuntimeAnalyticsBucketScheduler",
        "PlatformAlertMonitor",
    ):
        monkeypatch.setattr(main, name, PassiveSubsystem)
    for name in (
        "register_scheduler_instance",
        "set_validation_scheduler",
        "register_operational_retention_scheduler",
        "register_partition_maintenance_scheduler",
        "register_runtime_snapshot_scheduler",
        "register_runtime_analytics_bucket_scheduler",
        "register_alert_monitor",
    ):
        monkeypatch.setattr(main, name, lambda *_args, **_kwargs: None)

    async def exercise() -> None:
        async with main.lifespan(main.app):
            sender = get_webhook_sender()
            assert isinstance(sender, UnavailableWebhookSender)
            assert not isinstance(sender, HttpWebhookSender)
            assert sender.send_webhook(
                url="https://no-egress.example.net/test",
                payload={"event_type": "POLICY_SUBMITTED"},
            ) is False

    asyncio.run(exercise())
