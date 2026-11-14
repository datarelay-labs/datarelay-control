"""WP-F: secrets in connector storage / config export, and import name-conflict safety.

Covers audit findings:

* E-098  ``token_body`` (vendor token-exchange template) is masked on read, preserved when the masked
         placeholder is submitted back, and still resolved fail-closed for draft auth tests.
* E-123  workspace / connector / stream exports never carry a secret value, including values embedded in
         free-text body templates, and ``export_integrity`` states what was masked.
* E-124  additive/clone import detects name conflicts, requires an explicit choice (skip / rename) and is
         idempotent for the same preview.
* E-125  an imported connector starts with no inherited auth-check state.

Secret values are synthetic literals; they are asserted absent from the full response text.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db, get_db_read_bounded
from app.destinations.models import Destination
from app.main import app
from app.mappings.models import Mapping
from app.routes.models import Route
from app.runtime.preview_service import _overlay_connector_auth_test_draft
from app.security.secrets import (
    is_sensitive_field_name,
    mask_embedded_secret_text,
    mask_source_auth_json,
)
from app.sources.models import Source
from app.streams.models import Stream
from tests.config_mutation_test_helpers import put_connector

MASK = "********"
VENDOR_KEY = "VENDORKEY-literal-0a1b2c3d4e5f6071"
BODY_SECRET = "BODYSECRET-literal-9f8e7d6c5b4a3921"
LOGIN_RAW_SECRET = "LOGINRAWPW-literal-5566778899aabbcc"
PREFLIGHT_SECRET = "PREFLIGHTPW-literal-0011223344556677"
STREAM_BODY_SECRET = "STREAMBODY-literal-abcdef0123456789"
HEADER_SECRET = "TOKHDR-literal-1234567890abcdef"
NESTED_SECRET = "NESTEDSECRET-literal-0011223344"
DEST_SECRET = "dest-secret-literal-77"


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override
    app.dependency_overrides[get_db_read_bounded] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def _vendor_fields(**over: Any) -> dict[str, Any]:
    body = {
        "auth_type": "vendor_jwt_exchange",
        "user_id": "vendor-user",
        "api_key": VENDOR_KEY,
        "token_url": "https://auth.vendor.example/token",
        "token_method": "POST",
        "token_auth_mode": "none",
        "token_path": "$.access_token",
        "token_body_mode": "json",
    }
    body.update(over)
    return body


def _create_vendor(client: TestClient, name: str = "wpf-vendor", token_body: str | None = None) -> dict[str, Any]:
    payload = {
        "name": name,
        "base_url": "https://api.vendor.example",
        "verify_ssl": True,
        **_vendor_fields(token_body=token_body if token_body is not None else json.dumps({"vendor_key": BODY_SECRET})),
    }
    res = client.post("/api/v1/connectors/", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def _vendor_put(client: TestClient, cid: int, **over: Any) -> Any:
    """A UI-style full save: the saved api_key travels back as the masked placeholder."""

    return put_connector(client, cid, {"description": "edited", **_vendor_fields(api_key=MASK, **over)})


def _source_of(db: Session, connector_id: int) -> Source:
    db.expire_all()
    return db.query(Source).filter(Source.connector_id == connector_id).one()


# --------------------------------------------------------------------------------------------------
# E-098: token_body is a secret
# --------------------------------------------------------------------------------------------------


def test_token_body_is_a_declared_secret_field() -> None:
    assert is_sensitive_field_name("token_body")
    # The descriptor neighbours stay readable configuration.
    assert not is_sensitive_field_name("token_body_mode")
    masked = mask_source_auth_json("HTTP_API_POLLING", {"token_body": '{"a": "b"}', "token_body_mode": "json"})
    assert masked == {"token_body": MASK, "token_body_mode": "json"}


def test_token_body_unset_and_placeholder_only_values_are_not_masked() -> None:
    masked = mask_source_auth_json("HTTP_API_POLLING", {"token_body": "", "token_body_mode": "empty"})
    assert masked["token_body"] == ""
    masked = mask_source_auth_json("HTTP_API_POLLING", {"token_body": "{{vendor_body}}"})
    assert masked["token_body"] == "{{vendor_body}}"


def test_connector_api_masks_token_body_on_create_get_and_list(client: TestClient, db_session: Session) -> None:
    created = _create_vendor(client)
    cid = created["id"]
    detail = client.get(f"/api/v1/connectors/{cid}")
    listed = client.get("/api/v1/connectors/")
    for res in (detail, listed):
        assert res.status_code == 200, res.text
        assert BODY_SECRET not in res.text
        assert VENDOR_KEY not in res.text
    assert BODY_SECRET not in json.dumps(created)
    assert created["auth"]["token_body"] == MASK
    assert created["auth"]["token_body_configured"] is True
    assert created["auth"]["token_body_mode"] == "json"
    assert detail.json()["auth"]["token_body"] == MASK
    row = next(c for c in listed.json() if c["id"] == cid)
    assert row["auth"]["token_body"] == MASK
    # The stored value is untouched (the runtime needs it).
    assert BODY_SECRET in _source_of(db_session, cid).auth_json["token_body"]


def test_connector_api_token_body_not_configured_reports_empty(client: TestClient) -> None:
    created = _create_vendor(client, name="wpf-vendor-nobody", token_body="")
    assert created["auth"].get("token_body") in ("", None)
    assert created["auth"].get("token_body_configured", False) is False


def test_masked_token_body_round_trip_keeps_stored_value(client: TestClient, db_session: Session) -> None:
    cid = _create_vendor(client)["id"]
    # The UI sends the masked placeholder back untouched.
    res = _vendor_put(client, cid, token_body=MASK)
    assert res.status_code == 200, res.text
    assert BODY_SECRET not in res.text
    assert BODY_SECRET in _source_of(db_session, cid).auth_json["token_body"]


def test_blank_or_omitted_token_body_keeps_stored_value(client: TestClient, db_session: Session) -> None:
    cid = _create_vendor(client)["id"]
    for extra in ({"token_body": ""}, {}):
        res = _vendor_put(client, cid, **extra)
        assert res.status_code == 200, res.text
        assert BODY_SECRET in _source_of(db_session, cid).auth_json["token_body"]


def test_new_token_body_value_replaces_stored_value_and_is_masked_back(
    client: TestClient, db_session: Session
) -> None:
    cid = _create_vendor(client)["id"]
    replacement = json.dumps({"vendor_key": "REPLACED-literal-1122334455667788"})
    res = _vendor_put(client, cid, token_body=replacement)
    assert res.status_code == 200, res.text
    assert "REPLACED-literal" not in res.text
    assert res.json()["auth"]["token_body"] == MASK
    stored = _source_of(db_session, cid).auth_json["token_body"]
    assert "REPLACED-literal" in stored and BODY_SECRET not in stored


def test_draft_auth_test_resolves_masked_token_body_fail_closed() -> None:
    saved = {
        "auth_type": "vendor_jwt_exchange",
        "base_url": "https://api.vendor.example",
        "token_url": "https://auth.vendor.example/token",
        "api_key": VENDOR_KEY,
        "token_body_mode": "json",
        "token_body": json.dumps({"vendor_key": BODY_SECRET}),
    }
    unchanged = _overlay_connector_auth_test_draft(
        saved, {"base_url": saved["base_url"], "auth_type": "vendor_jwt_exchange", "token_body": MASK}
    )
    assert BODY_SECRET in unchanged["token_body"]
    blank = _overlay_connector_auth_test_draft(
        saved, {"base_url": saved["base_url"], "auth_type": "vendor_jwt_exchange", "token_body": ""}
    )
    assert BODY_SECRET in blank["token_body"]
    moved = _overlay_connector_auth_test_draft(
        saved,
        {"base_url": "https://attacker.example", "auth_type": "vendor_jwt_exchange", "token_body": MASK},
    )
    assert moved["token_body"] in ("", None)
    assert BODY_SECRET not in repr(moved)
    replaced = _overlay_connector_auth_test_draft(
        saved,
        {"base_url": "https://attacker.example", "auth_type": "vendor_jwt_exchange", "token_body": '{"k": "typed"}'},
    )
    assert replaced["token_body"] == '{"k": "typed"}'


# --------------------------------------------------------------------------------------------------
# E-123: exports never carry a secret value
# --------------------------------------------------------------------------------------------------


def test_mask_embedded_secret_text_json_form_and_placeholders() -> None:
    assert mask_embedded_secret_text("") == ""
    assert mask_embedded_secret_text("{{login_password}}") == "{{login_password}}"
    templ = '{"username": "{{login_username}}", "password": "{{login_password}}"}'
    assert mask_embedded_secret_text(templ) == templ
    assert mask_embedded_secret_text('{"user": "u", "password": "hunter2hunter2"}') == MASK
    assert mask_embedded_secret_text('{"a": {"b": [{"client_secret": "zzzzzzzz"}]}}') == MASK
    assert mask_embedded_secret_text("grant_type=password&password=hunter2hunter2&user=u") == MASK
    assert mask_embedded_secret_text("<auth><password>hunter2hunter2</password></auth>") == MASK
    plain = '{"limit": 10, "order": "asc"}'
    assert mask_embedded_secret_text(plain) == plain
    assert mask_embedded_secret_text("just some text") == "just some text"


def _seed_secret_bearing_graph(db: Session) -> dict[str, int]:
    """One connector whose stored configuration hides secrets in every shape the exporter must cover."""

    c = Connector(name="wpf-export-connector", description=None, status="STOPPED")
    db.add(c)
    db.flush()
    s = Source(
        connector_id=c.id,
        source_type="HTTP_API_POLLING",
        config_json={
            "base_url": "https://vendor.example",
            # A stored secret reappearing under an innocent key must be caught by the value scan.
            "operator_note": f"copied from the vault: {VENDOR_KEY}",
            "operational": {
                "auth_health_check_interval": "1h",
                "last_auth_check_at": "2026-11-13T08:00:00+00:00",
                "last_auth_check_status": "success",
            },
        },
        auth_json={
            "auth_type": "vendor_jwt_exchange",
            "user_id": "vendor-user",
            "api_key": VENDOR_KEY,
            "token_url": "https://auth.vendor.example/token",
            "token_body_mode": "json",
            "token_body": json.dumps({"vendor_key": BODY_SECRET}),
            "login_body_mode": "raw",
            "login_body_raw": json.dumps({"username": "svc", "password": LOGIN_RAW_SECRET}),
            "preflight_body_raw": f"grant=x&password={PREFLIGHT_SECRET}",
            "login_body_template": {"username": "svc", "nested": {"client_secret": NESTED_SECRET}},
            "token_custom_headers": {"X-Vendor-Credential": HEADER_SECRET, "Accept": "application/json"},
        },
        enabled=True,
    )
    db.add(s)
    db.flush()
    st = Stream(
        connector_id=c.id,
        source_id=s.id,
        name="wpf-export-stream",
        stream_type="HTTP_API_POLLING",
        config_json={
            "path": "/events",
            "request_body": json.dumps({"query": "x", "client_secret": STREAM_BODY_SECRET}),
        },
        polling_interval=120,
        enabled=False,
        status="STOPPED",
        rate_limit_json={},
    )
    db.add(st)
    db.flush()
    db.add(
        Mapping(
            stream_id=st.id,
            event_array_path="$.items",
            event_root_path=None,
            field_mappings_json={"a": {"source_json_path": "$.x", "output_field": "x"}},
            raw_payload_mode=None,
        )
    )
    d = Destination(
        name="wpf-export-dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://receiver.example/hook", "headers": {"X-Key": DEST_SECRET}},
        rate_limit_json={},
        enabled=True,
    )
    db.add(d)
    db.flush()
    db.add(
        Route(
            stream_id=st.id,
            destination_id=d.id,
            enabled=True,
            failure_policy="LOG_AND_CONTINUE",
            formatter_config_json={"message_format": "json"},
            rate_limit_json={},
            status="ENABLED",
        )
    )
    db.commit()
    return {"connector_id": int(c.id), "stream_id": int(st.id), "destination_id": int(d.id), "source_id": int(s.id)}


ALL_EXPORT_LITERALS = (
    VENDOR_KEY,
    BODY_SECRET,
    LOGIN_RAW_SECRET,
    PREFLIGHT_SECRET,
    STREAM_BODY_SECRET,
    HEADER_SECRET,
    NESTED_SECRET,
    DEST_SECRET,
)


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/backup/workspace/export",
        "/api/v1/backup/workspace/export?include_destinations=false&include_checkpoints=false",
        "/api/v1/backup/connectors/{cid}/export?include_destinations=true",
        "/api/v1/backup/streams/{sid}/export?include_destinations=true",
    ],
)
def test_every_export_kind_carries_no_secret_value(client: TestClient, db_session: Session, path: str) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    res = client.get(path.format(cid=ids["connector_id"], sid=ids["stream_id"]))
    assert res.status_code == 200, res.text
    for literal in ALL_EXPORT_LITERALS:
        assert literal not in res.text, literal
    integrity = res.json()["export_integrity"]
    assert integrity["secrets_masked"] is True, integrity
    assert integrity["issues"] == []


def test_export_masks_token_body_and_states_what_was_masked(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    data = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    auth = data["sources"][0]["auth_json"]
    assert auth["token_body"] == MASK
    assert auth["token_body_mode"] == "json"  # descriptor stays readable
    assert auth["login_body_raw"] == MASK
    assert auth["preflight_body_raw"] == MASK
    assert auth["api_key"] == MASK
    assert auth["token_custom_headers"]["Accept"] == "application/json"
    assert auth["token_custom_headers"]["X-Vendor-Credential"] == MASK
    stream_cfg = data["streams"][0]["config_json"]
    assert stream_cfg["request_body"] == MASK
    assert stream_cfg["path"] == "/events"
    integrity = data["export_integrity"]
    assert integrity["secrets_masked"] is True
    assert integrity["masked_field_count"] >= 6
    # The vendor key reappeared under an innocent key: it was redacted by value and the export says so.
    cfg = data["sources"][0]["config_json"]
    assert VENDOR_KEY not in json.dumps(cfg)
    assert any("operator_note" in p for p in integrity["value_scan_redactions"])


def test_export_keeps_placeholder_only_login_templates(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    templ = '{"username": "{{login_username}}", "password": "{{login_password}}"}'
    src = db_session.get(Source, ids["source_id"])
    auth = dict(src.auth_json)
    auth["login_body_raw"] = templ
    src.auth_json = auth
    db_session.commit()
    data = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    assert data["sources"][0]["auth_json"]["login_body_raw"] == templ


def test_export_fails_closed_when_a_secret_survives_masking(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.backup.export_builder as builder

    ids = _seed_secret_bearing_graph(db_session)
    monkeypatch.setattr(builder, "redact_known_secret_literals", lambda bundle, literals: [])
    res = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export")
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error_code"] == "EXPORT_SECRETS_NOT_MASKED"
    for literal in ALL_EXPORT_LITERALS:
        assert literal not in res.text, literal


def test_import_of_export_requires_reentry_of_token_body_and_never_stores_mask(
    client: TestClient, db_session: Session
) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export?include_destinations=true").json()
    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"}).json()
    assert any("Token body" in w["message"] for w in prev["warnings"]), prev["warnings"]
    res = client.post(
        "/api/v1/backup/import/apply",
        json={
            "bundle": bundle,
            "mode": "additive",
            "confirm": True,
            "preview_token": prev["preview_token"],
            "on_name_conflict": "rename",
        },
    )
    assert res.status_code == 200, res.text
    new_cid = res.json()["created"]["connector_ids"][0]
    stored = _source_of(db_session, new_cid).auth_json
    assert "token_body" not in stored
    assert MASK not in json.dumps(stored)
    assert any("Token body" in item["fields"] for item in res.json()["secrets_to_reenter"])


def test_same_environment_clone_still_carries_token_body_server_side(
    client: TestClient, db_session: Session
) -> None:
    cid = _create_vendor(client)["id"]
    res = client.post(f"/api/v1/backup/connectors/{cid}/clone", json={"name_suffix": " (copy)"})
    assert res.status_code == 200, res.text
    assert BODY_SECRET not in res.text
    new_cid = res.json()["connector_id"]
    cloned = _source_of(db_session, new_cid).auth_json
    assert BODY_SECRET in cloned["token_body"]
    assert cloned["api_key"] == VENDOR_KEY


# --------------------------------------------------------------------------------------------------
# E-124: import name conflicts
# --------------------------------------------------------------------------------------------------


def _bundle(client: TestClient, ids: dict[str, int], *, destinations: bool = True) -> dict[str, Any]:
    q = "?include_destinations=true" if destinations else ""
    res = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export{q}")
    assert res.status_code == 200, res.text
    return res.json()


def _preview(client: TestClient, bundle: dict[str, Any], mode: str = "additive") -> dict[str, Any]:
    res = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": mode})
    assert res.status_code == 200, res.text
    return res.json()


def _apply(
    client: TestClient, bundle: dict[str, Any], token: str, mode: str = "additive", **extra: Any
) -> Any:
    return client.post(
        "/api/v1/backup/import/apply",
        json={"bundle": bundle, "mode": mode, "confirm": True, "preview_token": token, **extra},
    )


def _names(db: Session, model: Any) -> list[str]:
    db.expire_all()
    return sorted(str(r.name) for r in db.query(model).all())


def test_preview_reports_connector_and_destination_name_conflicts(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    prev = _preview(client, _bundle(client, ids))
    assert prev["ok"] is True
    conflicts = {(c["entity_type"], c["name"]) for c in prev["name_conflicts"]}
    assert ("connector", "wpf-export-connector") in conflicts
    assert ("destination", "wpf-export-dest") in conflicts
    conn = next(c for c in prev["name_conflicts"] if c["entity_type"] == "connector")
    assert conn["existing_ids"] == [ids["connector_id"]]
    assert conn["export_id"] == ids["connector_id"]
    assert prev["requires_name_conflict_choice"] is True
    assert {"skip", "rename"} <= set(prev["name_conflict_choices"])
    assert "CONNECTOR_NAME_EXISTS" in {f["code"] for f in prev["findings"]}


def test_preview_without_conflicts_requires_no_choice(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = _bundle(client, ids)
    bundle["connectors"][0]["name"] = "wpf-brand-new-name"
    bundle["destinations"][0]["name"] = "wpf-brand-new-dest"
    prev = _preview(client, bundle)
    assert prev["name_conflicts"] == []
    assert prev["requires_name_conflict_choice"] is False
    res = _apply(client, bundle, prev["preview_token"])
    assert res.status_code == 200, res.text
    assert res.json()["skipped"] == [] and res.json()["renamed"] == []
    assert "wpf-brand-new-name" in _names(db_session, Connector)


def test_apply_without_choice_is_refused_and_writes_nothing(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = _bundle(client, ids)
    prev = _preview(client, bundle)
    before = (db_session.query(Connector).count(), db_session.query(Destination).count())
    res = _apply(client, bundle, prev["preview_token"])
    assert res.status_code == 409, res.text
    detail = res.json()["detail"]
    assert detail["error_code"] == "IMPORT_NAME_CONFLICT_UNRESOLVED"
    assert {c["name"] for c in detail["name_conflicts"]} >= {"wpf-export-connector", "wpf-export-dest"}
    db_session.expire_all()
    assert (db_session.query(Connector).count(), db_session.query(Destination).count()) == before


def test_apply_with_unknown_choice_is_rejected(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = _bundle(client, ids)
    prev = _preview(client, bundle)
    res = _apply(client, bundle, prev["preview_token"], on_name_conflict="overwrite")
    assert res.status_code == 422, res.text


def _counts(db: Session) -> tuple[int, ...]:
    db.expire_all()
    return (
        db.query(Connector).count(),
        db.query(Source).count(),
        db.query(Stream).count(),
        db.query(Destination).count(),
        db.query(Route).count(),
    )


def test_apply_skip_creates_nothing_and_same_preview_twice_is_idempotent(
    client: TestClient, db_session: Session
) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = _bundle(client, ids)
    prev = _preview(client, bundle)
    before = _counts(db_session)
    for _ in range(2):
        res = _apply(client, bundle, prev["preview_token"], on_name_conflict="skip")
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["created"]["connector_ids"] == []
        assert body["created"]["stream_ids"] == []
        assert body["created"]["destination_ids"] == []
        assert {s["entity_type"] for s in body["skipped"]} == {"connector", "destination"}
        assert all(s["reason"] == "NAME_EXISTS" for s in body["skipped"])
        assert _counts(db_session) == before


def test_apply_rename_creates_unique_names_and_never_duplicates(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = _bundle(client, ids)
    prev = _preview(client, bundle)
    first = _apply(client, bundle, prev["preview_token"], on_name_conflict="rename")
    assert first.status_code == 200, first.text
    second = _apply(client, bundle, prev["preview_token"], on_name_conflict="rename")
    assert second.status_code == 200, second.text
    names = _names(db_session, Connector)
    assert names == ["wpf-export-connector", "wpf-export-connector (2)", "wpf-export-connector (3)"]
    dest_names = _names(db_session, Destination)
    assert len(set(dest_names)) == len(dest_names) == 3
    renamed = first.json()["renamed"]
    assert {(r["entity_type"], r["name"], r["new_name"]) for r in renamed} == {
        ("connector", "wpf-export-connector", "wpf-export-connector (2)"),
        ("destination", "wpf-export-dest", "wpf-export-dest (2)"),
    }
    # Imported streams are re-bound to the renamed destination, never to the original one.
    new_stream = first.json()["created"]["stream_ids"][0]
    route = db_session.query(Route).filter(Route.stream_id == new_stream).one()
    assert route.destination_id == first.json()["created"]["destination_ids"][0]


def test_apply_skip_destination_only_skips_routes_that_use_it(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = _bundle(client, ids)
    bundle["connectors"][0]["name"] = "wpf-new-connector-only"
    prev = _preview(client, bundle)
    assert [c["entity_type"] for c in prev["name_conflicts"]] == ["destination"]
    res = _apply(client, bundle, prev["preview_token"], on_name_conflict="skip")
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["created"]["connector_ids"]) == 1
    assert body["created"]["destination_ids"] == []
    assert {s["entity_type"] for s in body["skipped"]} == {"destination", "route"}
    new_stream = body["created"]["stream_ids"][0]
    assert db_session.query(Route).filter(Route.stream_id == new_stream).count() == 0


def test_clone_mode_import_twice_hits_the_same_conflict_gate(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = _bundle(client, ids, destinations=False)
    prev = _preview(client, bundle, mode="clone")
    assert prev["name_conflicts"] == []
    first = _apply(client, bundle, prev["preview_token"], mode="clone")
    assert first.status_code == 200, first.text
    again = _apply(client, bundle, prev["preview_token"], mode="clone")
    assert again.status_code == 409, again.text
    assert again.json()["detail"]["error_code"] == "IMPORT_NAME_CONFLICT_UNRESOLVED"
    skipped = _apply(client, bundle, prev["preview_token"], mode="clone", on_name_conflict="skip")
    assert skipped.status_code == 200 and skipped.json()["created"]["connector_ids"] == []
    assert _names(db_session, Connector) == ["wpf-export-connector", "wpf-export-connector (copy)"]


def test_repeated_connector_clone_endpoint_yields_distinct_names(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    for _ in range(2):
        res = client.post(f"/api/v1/backup/connectors/{ids['connector_id']}/clone", json={})
        assert res.status_code == 200, res.text
    names = _names(db_session, Connector)
    assert len(set(names)) == len(names) == 3


def test_idempotency_key_replay_still_works_with_conflict_choice(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = _bundle(client, ids)
    prev = _preview(client, bundle)
    kw = {"on_name_conflict": "rename", "idempotency_key": "wpf-op-1"}
    first = _apply(client, bundle, prev["preview_token"], **kw)
    second = _apply(client, bundle, prev["preview_token"], **kw)
    assert first.status_code == second.status_code == 200
    assert second.json()["idempotent_replay"] is True
    assert db_session.query(Connector).count() == 2


# --------------------------------------------------------------------------------------------------
# E-125: no inherited auth-check state
# --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["additive", "clone"])
def test_imported_connector_starts_without_auth_check_state(
    client: TestClient, db_session: Session, mode: str
) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    bundle = _bundle(client, ids, destinations=(mode == "additive"))
    assert bundle["sources"][0]["config_json"]["operational"]["last_auth_check_status"] == "success"
    prev = _preview(client, bundle, mode=mode)
    extra = {"on_name_conflict": "rename"} if mode == "additive" else {}
    res = _apply(client, bundle, prev["preview_token"], mode=mode, **extra)
    assert res.status_code == 200, res.text
    new_cid = res.json()["created"]["connector_ids"][0]
    op = (_source_of(db_session, new_cid).config_json or {}).get("operational") or {}
    assert "last_auth_check_at" not in op
    assert "last_auth_check_status" not in op
    assert "last_auth_error" not in op
    assert op.get("auth_health_check_interval") == "1h"  # configuration is kept
    detail = client.get(f"/api/v1/connectors/{new_cid}").json()
    assert detail.get("last_auth_check_status") in (None, "")
    assert detail.get("last_auth_check_at") in (None, "")


def test_connector_clone_endpoint_resets_auth_check_state(client: TestClient, db_session: Session) -> None:
    ids = _seed_secret_bearing_graph(db_session)
    res = client.post(f"/api/v1/backup/connectors/{ids['connector_id']}/clone", json={})
    assert res.status_code == 200, res.text
    new_cid = res.json()["connector_id"]
    op = (_source_of(db_session, new_cid).config_json or {}).get("operational") or {}
    assert "last_auth_check_status" not in op
    # The original keeps its own state.
    orig = (_source_of(db_session, ids["connector_id"]).config_json or {}).get("operational") or {}
    assert orig["last_auth_check_status"] == "success"


def test_connector_clone_keeps_content_masked_bodies_server_side(client: TestClient, db_session: Session) -> None:
    """Codex review: the clone endpoint must keep login/preflight/stream request bodies (masked in downloads)."""

    ids = _seed_secret_bearing_graph(db_session)
    res = client.post(f"/api/v1/backup/connectors/{ids['connector_id']}/clone", json={})
    assert res.status_code == 200, res.text
    for literal in ALL_EXPORT_LITERALS:
        assert literal not in res.text
    new_cid = res.json()["connector_id"]
    cloned = _source_of(db_session, new_cid).auth_json
    assert LOGIN_RAW_SECRET in cloned["login_body_raw"]
    assert PREFLIGHT_SECRET in cloned["preflight_body_raw"]
    assert BODY_SECRET in cloned["token_body"]
    new_stream = db_session.query(Stream).filter(Stream.connector_id == new_cid).one()
    assert STREAM_BODY_SECRET in new_stream.config_json["request_body"]
    assert new_stream.config_json["path"] == "/events"
    # The downloadable export of the original stays masked.
    exported = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export")
    assert LOGIN_RAW_SECRET not in exported.text
