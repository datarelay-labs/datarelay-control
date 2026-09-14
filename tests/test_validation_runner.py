"""Continuous validation runner (StreamRunner-backed synthetic operational checks)."""

from __future__ import annotations

import threading
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.main import app
from app.templates.registry import clear_template_cache
from app.database import SessionLocal
from app.validation.models import ContinuousValidation, ValidationRun
from app.validation.runner import _evaluate_checks, execute_continuous_validation_row
from tests.e2e_wiremock_helpers import (
    DEFAULT_WIREMOCK,
    create_webhook_destination,
    enable_stream_for_run,
    ensure_template_wiremock_mappings,
    reset_wiremock_journal,
    reset_wiremock_scenarios,
    wiremock_reachable,
)

skip_no_wiremock = pytest.mark.skipif(
    not wiremock_reachable(DEFAULT_WIREMOCK),
    reason=f"WireMock not reachable at {DEFAULT_WIREMOCK}",
)


@pytest.fixture
def client(db_session: Session) -> Any:
    clear_template_cache()

    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        clear_template_cache()


def test_evaluate_checks_full_runtime_checkpoint_drift() -> None:
    summary = {
        "outcome": "completed",
        "transaction_committed": True,
        "extracted_event_count": 2,
        "delivered_batch_event_count": 2,
        "checkpoint_updated": False,
    }
    stats = {"route_send_success": 1, "route_send_failed": 0, "route_retry_failed": 0, "run_complete": 1}
    overall, messages = _evaluate_checks(
        validation_type="FULL_RUNTIME", summary=summary, stats=stats, expect_checkpoint_advance=True
    )
    assert overall == "FAIL"
    assert any("checkpoint drift" in m.lower() for m in messages)


def test_evaluate_checks_recovery_semantics_next_run() -> None:
    """After a synthetic FAIL, a PASS-shaped summary should be PASS (used by runner for reset)."""

    fail_summary = {"outcome": "source_fetch_failed", "message": "401", "transaction_committed": False, "run_id": None}
    o1, _ = _evaluate_checks(validation_type="AUTH_ONLY", summary=fail_summary, stats={}, expect_checkpoint_advance=True)
    assert o1 == "FAIL"

    ok_summary = {
        "outcome": "completed",
        "transaction_committed": True,
        "extracted_event_count": 1,
        "delivered_batch_event_count": 1,
        "checkpoint_updated": True,
    }
    stats = {"route_send_success": 1, "route_send_failed": 0, "route_retry_failed": 0, "run_complete": 1}
    o2, _ = _evaluate_checks(
        validation_type="FULL_RUNTIME", summary=ok_summary, stats=stats, expect_checkpoint_advance=True
    )
    assert o2 == "PASS"


@skip_no_wiremock
@pytest.mark.wiremock_integration
def test_validation_success_full_runtime(client: TestClient, db_session: Session) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "cv-generic",
            "host": base,
            "credentials": {"bearer_token": "template-e2e-generic-bearer"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    enable_stream_for_run(client, stream_id)

    v = ContinuousValidation(
        name="full-runtime",
        enabled=True,
        validation_type="FULL_RUNTIME",
        target_stream_id=stream_id,
        schedule_seconds=3600,
        expect_checkpoint_advance=True,
    )
    db_session.add(v)
    db_session.commit()
    db_session.refresh(v)

    r = client.post(f"/api/v1/validation/{v.id}/run")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overall_status"] == "PASS"

    db_session.expire_all()
    runs = db_session.query(ValidationRun).filter(ValidationRun.validation_id == v.id).all()
    assert len(runs) >= 1
    assert any(x.status == "PASS" for x in runs)


@skip_no_wiremock
@pytest.mark.wiremock_integration
def test_validation_auth_failure_auth_only(client: TestClient, db_session: Session) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "cv-auth-fail",
            "host": base,
            "credentials": {"bearer_token": "wrong-token"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    enable_stream_for_run(client, stream_id)

    v = ContinuousValidation(
        name="auth-only",
        enabled=True,
        validation_type="AUTH_ONLY",
        target_stream_id=stream_id,
        schedule_seconds=3600,
        expect_checkpoint_advance=False,
    )
    db_session.add(v)
    db_session.commit()
    db_session.refresh(v)

    r = client.post(f"/api/v1/validation/{v.id}/run")
    assert r.status_code == 200, r.text
    assert r.json()["overall_status"] == "FAIL"


@skip_no_wiremock
@pytest.mark.wiremock_integration
def test_validation_destination_failure_full_runtime(client: TestClient, db_session: Session) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/wiremock-integration/receiver-fail", retry_count=0)
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "cv-dest-fail",
            "host": base,
            "credentials": {"bearer_token": "template-e2e-generic-bearer"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    enable_stream_for_run(client, stream_id)

    v = ContinuousValidation(
        name="dest-fail",
        enabled=True,
        validation_type="FULL_RUNTIME",
        target_stream_id=stream_id,
        schedule_seconds=3600,
        expect_checkpoint_advance=True,
    )
    db_session.add(v)
    db_session.commit()
    db_session.refresh(v)

    r = client.post(f"/api/v1/validation/{v.id}/run")
    assert r.status_code == 200, r.text
    assert r.json()["overall_status"] == "FAIL"


@skip_no_wiremock
@pytest.mark.wiremock_integration
def test_validation_recovery_after_success(client: TestClient, db_session: Session) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "cv-recover",
            "host": base,
            "credentials": {"bearer_token": "wrong"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    enable_stream_for_run(client, stream_id)

    v = ContinuousValidation(
        name="recover",
        enabled=True,
        validation_type="AUTH_ONLY",
        target_stream_id=stream_id,
        schedule_seconds=3600,
        expect_checkpoint_advance=False,
    )
    db_session.add(v)
    db_session.commit()
    db_session.refresh(v)

    client.post(f"/api/v1/validation/{v.id}/run")
    db_session.refresh(v)
    assert int(v.consecutive_failures or 0) >= 1

    cid = int(ins.json()["connector_id"])
    from tests.config_mutation_test_helpers import put_connector

    ur = put_connector(client, cid, {"bearer_token": "template-e2e-generic-bearer"})
    assert ur.status_code == 200, ur.text

    r2 = client.post(f"/api/v1/validation/{v.id}/run")
    assert r2.status_code == 200
    db_session.refresh(v)
    assert int(v.consecutive_failures or 0) == 0


@skip_no_wiremock
@pytest.mark.wiremock_integration
def test_validation_lock_protection(client: TestClient, db_session: Session) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "cv-lock",
            "host": base,
            "credentials": {"bearer_token": "template-e2e-generic-bearer"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    enable_stream_for_run(client, stream_id)

    v = ContinuousValidation(
        name="lock",
        enabled=True,
        validation_type="FULL_RUNTIME",
        target_stream_id=stream_id,
        schedule_seconds=3600,
        expect_checkpoint_advance=True,
    )
    db_session.add(v)
    db_session.commit()
    vid = int(v.id)

    barrier = threading.Barrier(2)
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            barrier.wait()
            s = SessionLocal()
            try:
                row = s.get(ContinuousValidation, vid)
                assert row is not None
                execute_continuous_validation_row(row)
            finally:
                s.close()
        except BaseException as exc:  # pragma: no cover
            errors.append(exc)

    t1 = threading.Thread(target=worker)
    t2 = threading.Thread(target=worker)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    assert not errors

    db_session.expire_all()
    locks = (
        db_session.query(ValidationRun)
        .filter(ValidationRun.validation_id == vid, ValidationRun.validation_stage == "validation_lock")
        .count()
    )
    assert locks >= 1


def test_validation_scheduler_tick_handles_empty_table(db_session: Session) -> None:
    from app.validation.periodic_scheduler import ContinuousValidationScheduler

    sch = ContinuousValidationScheduler()
    sch.start()
    sch.stop()
