"""F-200 / F-193 / F-201: admin and settings audit rows name the acting user; no look-alike usernames."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.auth.login_throttle import reset_login_throttle_for_tests
from app.auth.security import get_password_hash
from app.database import get_db
from app.main import app
from app.platform_admin.models import PlatformUser

PASSWORD = "ExamplePassword9!"
ADMIN = "acting-admin"


@pytest.fixture
def admin_client(db_session: Session):
    reset_login_throttle_for_tests()

    def override():
        yield db_session

    app.dependency_overrides[get_db] = override
    db_session.add(
        PlatformUser(
            username=ADMIN,
            password_hash=get_password_hash(PASSWORD),
            role="ADMINISTRATOR",
            status="ACTIVE",
            token_version=1,
        )
    )
    db_session.commit()
    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": ADMIN, "password": PASSWORD})
        assert login.status_code == 200, login.text
        client.headers.update({"Authorization": "Bearer " + login.json()["access_token"]})
        yield client
    app.dependency_overrides.pop(get_db, None)
    reset_login_throttle_for_tests()


def _rows(db: Session, action: str) -> list[AuditLog]:
    db.expire_all()
    return db.query(AuditLog).filter(AuditLog.action == action).all()


def test_user_created_is_attributed_to_the_acting_admin(admin_client: TestClient, db_session: Session) -> None:
    resp = admin_client.post(
        "/api/v1/admin/users", json={"username": "new-user-1", "password": PASSWORD, "role": "VIEWER"}
    )
    assert resp.status_code == 201, resp.text
    rows = _rows(db_session, "USER_CREATED")
    assert len(rows) == 1
    assert rows[0].actor_username == ADMIN
    assert rows[0].metadata_json.get("entity_name") == "new-user-1"


def test_display_settings_update_is_attributed_to_the_acting_admin(
    admin_client: TestClient, db_session: Session
) -> None:
    resp = admin_client.put("/api/v1/admin/display-settings", json={"default_timezone": "Asia/Seoul"})
    assert resp.status_code == 200, resp.text
    rows = _rows(db_session, "DISPLAY_SETTINGS_UPDATED")
    assert rows and rows[-1].actor_username == ADMIN


def test_user_update_and_delete_are_attributed_to_the_acting_admin(
    admin_client: TestClient, db_session: Session
) -> None:
    created = admin_client.post(
        "/api/v1/admin/users", json={"username": "temp-user-2", "password": PASSWORD, "role": "VIEWER"}
    ).json()
    patched = admin_client.patch(f"/api/v1/admin/users/{created['id']}", json={"role": "OPERATOR"})
    assert patched.status_code == 200, patched.text
    deleted = admin_client.delete(f"/api/v1/admin/users/{created['id']}")
    assert deleted.status_code in (200, 204), deleted.text
    assert [r.actor_username for r in _rows(db_session, "USER_UPDATED")] == [ADMIN]
    assert [r.actor_username for r in _rows(db_session, "USER_DELETED")] == [ADMIN]


def test_case_insensitive_duplicate_username_is_rejected(admin_client: TestClient, db_session: Session) -> None:
    first = admin_client.post(
        "/api/v1/admin/users", json={"username": "Alice", "password": PASSWORD, "role": "VIEWER"}
    )
    assert first.status_code == 201, first.text
    for variant in ("alice", "ALICE", "aLiCe"):
        dup = admin_client.post(
            "/api/v1/admin/users", json={"username": variant, "password": PASSWORD, "role": "VIEWER"}
        )
        assert dup.status_code == 409, variant
        assert dup.json()["detail"]["error_code"] == "USER_USERNAME_TAKEN"
    assert db_session.query(PlatformUser).filter(PlatformUser.username.ilike("alice")).count() == 1
