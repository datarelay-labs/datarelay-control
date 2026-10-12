"""PF-12A Control safe configuration rollback preview (read-only, no DB)."""

from __future__ import annotations

import pytest

from app.platform_admin.config_safe_rollback_preview import build_safe_rollback_readiness


def _preview(**changes):
    args = {
        "entity_type": "STREAM_CONFIG",
        "current_version": 18,
        "expected_version": 18,
        "target_version": 13,
        "target_side": "after",
        "current_snapshot": {
            "kind": "STREAM_CONFIG",
            "enabled": False,
            "polling_interval": 120,
            "config_json": {"api_key": "private-key-do-not-export", "endpoint": "/secret"},
            "rate_limit_json": {"authorization": "secret-rate-config"},
        },
        "target_snapshot": {
            "kind": "STREAM_CONFIG",
            "enabled": True,
            "polling_interval": 60,
            "config_json": {"password": "private-password"},
            "rate_limit_json": {"token": "private-token"},
        },
        "current_created_at": 200,
        "target_created_at": 100,
        "actor_authorized": True,
        "recent_mfa_verified": False,
    }
    args.update(changes)
    return build_safe_rollback_readiness(**args)


def test_preview_uses_allowlisted_public_scalars_and_reuses_foundation_contract():
    preview = _preview()
    assert preview["entity_type"] == "STREAM_CONFIG"
    assert preview["current_version"] == 18
    assert preview["source_version"] == 13
    assert preview["changed_fields"] == [
        {"path": "enabled", "before": "true", "after": "false"},
        {"path": "polling_interval", "before": "60", "after": "120"},
    ]
    assert "mfa_required" in preview["blockers"]
    assert "backup_missing" in preview["blockers"]
    assert "unsupported" in preview["blockers"]
    assert preview["may_submit_to_product_authority"] is False
    assert preview["product_apply_required"] is True
    assert len(preview["from_fingerprint"]) == 64
    assert len(preview["to_fingerprint"]) == 64
    serialized = repr(preview)
    for secret in ("private-key", "private-password", "private-token", "/secret"):
        assert secret not in serialized


def test_preview_is_order_independent_and_flags_stale_client_revision():
    current = {"polling_interval": 120, "enabled": False}
    target = {"polling_interval": 60, "enabled": True}
    normal = _preview(current_snapshot=current, target_snapshot=target)
    reversed_order = _preview(
        current_snapshot={"enabled": False, "polling_interval": 120},
        target_snapshot={"enabled": True, "polling_interval": 60},
    )
    assert normal["from_fingerprint"] == reversed_order["from_fingerprint"]
    assert normal["to_fingerprint"] == reversed_order["to_fingerprint"]
    stale = _preview(expected_version=17)
    assert "wrong_revision" in stale["blockers"]


@pytest.mark.parametrize(
    "entity_type,current,target,expected_paths",
    [
        ("ROUTE_CONFIG",
         {"enabled": False, "failure_policy": "LOG_AND_CONTINUE", "formatter_config_json": {"token": "secret"}},
         {"enabled": True, "failure_policy": "PAUSE_STREAM_ON_FAILURE", "formatter_config_json": {"api_key": "secret"}},
         ["enabled", "failure_policy"]),
        ("DESTINATION_CONFIG",
         {"enabled": False, "config_json": {"password": "secret"}},
         {"enabled": True, "config_json": {"private_key": "secret"}},
         ["enabled"]),
    ],
)
def test_other_entities_never_return_raw_sensitive_fields(entity_type, current, target, expected_paths):
    result = _preview(entity_type=entity_type, current_snapshot=current, target_snapshot=target)
    assert sorted(x["path"] for x in result["changed_fields"]) == expected_paths
    assert "secret" not in repr(result)
    assert result["may_submit_to_product_authority"] is False


@pytest.mark.parametrize(
    "mutations",
    [
        {"entity_type": "MAPPING_CONFIG"},
        {"current_snapshot": {"enabled": "false", "polling_interval": 120}},
        {"target_snapshot": {"enabled": True, "polling_interval": -10}},
        {"target_snapshot": {"enabled": True}},
        {"current_snapshot": {"enabled": False, "polling_interval": 120, "kind": "DESTINATION_CONFIG"}},
        {"target_side": "sideways"},
    ],
)
def test_unsupported_or_malformed_revision_fails_closed(mutations):
    with pytest.raises(ValueError):
        _preview(**mutations)


def test_target_newer_than_live_revision_is_rejected():
    with pytest.raises(ValueError):
        _preview(target_version=25)


def test_no_differences_and_unknown_security_evidence_never_authorizes_rollback():
    fields = {"enabled": False, "polling_interval": 120}
    result = _preview(
        current_snapshot=fields, target_snapshot=dict(fields),
        actor_authorized=False, recent_mfa_verified=False,
    )
    assert result["changed_fields"] == []
    assert result["may_submit_to_product_authority"] is False
    assert "unauthorized" in result["blockers"]


def test_existing_admin_revision_readiness_route_uses_server_history_without_mutation(monkeypatch):
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from app.platform_admin import router as api

    history = SimpleNamespace(
        id=7,
        version=13,
        entity_type="STREAM_CONFIG",
        entity_id=51,
        created_at=datetime(2026, 10, 10, tzinfo=timezone.utc),
        snapshot_before_json={"kind": "STREAM_CONFIG", "enabled": True, "polling_interval": 60},
        snapshot_after_json={"kind": "STREAM_CONFIG", "enabled": False, "polling_interval": 90},
    )
    monkeypatch.setattr(api, "get_config_version_by_id", lambda _db, row_id: history if row_id == 7 else None)
    monkeypatch.setattr(api, "current_entity_config_version", lambda *_a, **_kw: 18)
    monkeypatch.setattr(
        api, "_capture_live",
        lambda *_a: {
            "kind": "STREAM_CONFIG",
            "enabled": False,
            "polling_interval": 120,
            "config_json": {"api_key": "never-export"},
        },
    )
    request = SimpleNamespace(
        state=SimpleNamespace(auth=SimpleNamespace(
            role="ADMINISTRATOR", source="jwt", mfa_verified=False,
        )),
    )
    result = api.read_safe_config_rollback_preview(
        row_id=7, request=request, db=object(), expected_version=18, target="before",
    ).model_dump()
    assert result["source_version_row_id"] == 7
    assert result["target"] == "before"
    assert result["current_version"] == 18
    assert result["changed_fields"][0]["path"] == "enabled"
    assert result["may_submit_to_product_authority"] is False
    assert "mfa_required" in result["blockers"]
    assert "never-export" not in repr(result)


def test_admin_readiness_route_never_promotes_development_identity_to_authorized(monkeypatch):
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from app.platform_admin import router as api

    row = SimpleNamespace(
        id=3, version=5, entity_type="DESTINATION_CONFIG", entity_id=1,
        created_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
        snapshot_before_json={"kind": "DESTINATION_CONFIG", "enabled": False},
        snapshot_after_json={"kind": "DESTINATION_CONFIG", "enabled": True},
    )
    monkeypatch.setattr(api, "get_config_version_by_id", lambda *_a: row)
    monkeypatch.setattr(api, "current_entity_config_version", lambda *_a, **_k: 9)
    monkeypatch.setattr(api, "_capture_live", lambda *_a: {"kind": "DESTINATION_CONFIG", "enabled": True})
    request = SimpleNamespace(state=SimpleNamespace(auth=SimpleNamespace(
        role="ADMINISTRATOR", source="anonymous_admin", mfa_verified=True,
    )))
    res = api.read_safe_config_rollback_preview(
        row_id=3, request=request, db=object(), expected_version=9, target="before",
    )
    assert res.may_submit_to_product_authority is False
    assert "unauthorized" in res.blockers


def test_http_safe_preview_exposes_only_allowlisted_scalars_without_database(monkeypatch):
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.database import get_db_read_bounded
    from app.platform_admin import router as admin_api

    recorded = SimpleNamespace(
        id=4, version=7, entity_type="ROUTE_CONFIG", entity_id=31,
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        snapshot_before_json={
            "kind": "ROUTE_CONFIG", "enabled": False,
            "failure_policy": "LOG_AND_CONTINUE",
            "formatter_config_json": {"bearer_token": "never-visible"},
        },
        snapshot_after_json={
            "kind": "ROUTE_CONFIG", "enabled": True,
            "failure_policy": "RETRY_AND_BACKOFF",
        },
    )
    monkeypatch.setattr(admin_api, "get_config_version_by_id", lambda _db, _id: recorded)
    monkeypatch.setattr(admin_api, "current_entity_config_version", lambda *_a, **_k: 12)
    monkeypatch.setattr(admin_api, "_capture_live", lambda *_a: {
        "kind": "ROUTE_CONFIG", "enabled": True,
        "failure_policy": "DISABLE_ROUTE_ON_FAILURE",
        "formatter_config_json": {"password": "very-secret"},
    })
    app = FastAPI()
    app.include_router(admin_api.router, prefix="/api/v1/admin")
    app.dependency_overrides[get_db_read_bounded] = lambda: object()
    result = TestClient(app).get(
        "/api/v1/admin/config-versions/4/safe-rollback-preview",
        params={"target": "before", "expected_version": 11},
    )
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["source_version_row_id"] == 4
    assert "wrong_revision" in data["blockers"]
    assert "unsupported" in data["blockers"]
    assert data["may_submit_to_product_authority"] is False
    assert "never-visible" not in result.text
    assert "very-secret" not in result.text


def test_http_safe_preview_missing_history_fails_closed(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.database import get_db_read_bounded
    from app.platform_admin import router as admin_api

    monkeypatch.setattr(admin_api, "get_config_version_by_id", lambda _db, _id: None)
    app = FastAPI()
    app.include_router(admin_api.router, prefix="/api/v1/admin")
    app.dependency_overrides[get_db_read_bounded] = lambda: object()
    result = TestClient(app).get(
        "/api/v1/admin/config-versions/4/safe-rollback-preview",
        params={"expected_version": 11},
    )
    assert result.status_code == 404
    assert result.json()["detail"]["error_code"] == "CONFIG_VERSION_NOT_FOUND"
