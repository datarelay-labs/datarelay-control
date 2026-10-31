"""M16.1 Runtime Hot Path Optimization — detection sharing and vault batching."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.classification.service import classify_events_for_delivery
from app.dynamic_routing.dynamic_routing_service import evaluate_dynamic_routes_for_delivery
from app.protection.engine import protect_batch
from app.protection.identity_vault import get_or_create_tokens_batch
from app.protection.models import IdentityVaultEntry, StreamProtectionRule
from app.protection.policy_service import evaluate_policies_for_delivery
from app.sensitive_detection.context import build_sensitive_detection_context
from app.sensitive_detection.service import detect_sensitive_fields
from tests.test_stream_runner_e2e import _seed_stream_runtime


@pytest.fixture
def hot_path_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_CLASSIFICATION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_HASH_SALT", "test-protection-salt")
    monkeypatch.setattr("app.config.settings.GDC_IDENTITY_VAULT_HASH_SALT", "test-vault-salt")


def _events_with_secret(count: int) -> list[dict]:
    return [{"api_key": f"sk-test-{i}", "email": f"user{i}@example.com"} for i in range(count)]


def test_runtime_detect_hits_called_once_per_batch(
    db_session: Session,
    hot_path_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    events = _events_with_secret(3)
    calls: list[int] = []

    def _spy(events_arg: list) -> list[dict]:
        calls.append(len(events_arg))
        from app.sensitive_detection.detection import detect_hits_for_batch as real

        return real(events_arg)

    with patch("app.sensitive_detection.context.detect_hits_for_batch", side_effect=_spy):
        ctx = detect_sensitive_fields(db, stream_id=stream_id, events=events)
        assert ctx is not None
        classify_events_for_delivery(
            db,
            stream_id=stream_id,
            enriched_events=events,
            detection_context=ctx,
        )
        evaluate_policies_for_delivery(
            db,
            stream_id=stream_id,
            enriched_events=events,
            detection_context=ctx,
        )
        evaluate_dynamic_routes_for_delivery(
            db,
            stream_id=stream_id,
            enriched_events=events,
            detection_context=ctx,
        )

    assert calls == [3]


def test_classification_reuses_context_findings(
    db_session: Session,
    hot_path_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    events = [{"password": "secret-value"}]
    ctx = build_sensitive_detection_context(stream_id=stream_id, events=events)
    assert ctx is not None

    with patch("app.sensitive_detection.detection.detect_hits_for_batch") as mock_detect:
        classify_events_for_delivery(
            db,
            stream_id=stream_id,
            enriched_events=events,
            detection_context=ctx,
        )
        mock_detect.assert_not_called()


def test_policy_reuses_context_findings(
    db_session: Session,
    hot_path_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    events = [{"api_key": "sk-live-abc123456789"}]
    ctx = build_sensitive_detection_context(stream_id=stream_id, events=events)
    assert ctx is not None

    with patch("app.sensitive_detection.detection.detect_hits_for_batch") as mock_detect:
        evaluate_policies_for_delivery(
            db,
            stream_id=stream_id,
            enriched_events=events,
            detection_context=ctx,
        )
        mock_detect.assert_not_called()


def test_dynamic_routing_reuses_context_findings(
    db_session: Session,
    hot_path_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    events = [{"token": "abcd1234secret"}]
    ctx = build_sensitive_detection_context(stream_id=stream_id, events=events)
    assert ctx is not None

    with patch("app.sensitive_detection.detection.detect_hits_for_batch") as mock_detect:
        evaluate_dynamic_routes_for_delivery(
            db,
            stream_id=stream_id,
            enriched_events=events,
            detection_context=ctx,
        )
        mock_detect.assert_not_called()


def test_tokenization_batch_single_lookup_query(
    db_session: Session,
    hot_path_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.email",
            sensitivity_class="pii",
            protection_mode="tokenization",
            enabled=True,
            created_by="test",
        )
    )
    db.commit()

    events = [{"email": f"user{i % 5}@company.com"} for i in range(100)]
    select_count = 0

    def _count_selects(_conn, _cursor, statement, _parameters, _context, _executemany) -> None:
        nonlocal select_count
        if statement is not None and "identity_vault_entries" in str(statement).lower():
            select_count += 1

    event.listen(db.get_bind(), "before_cursor_execute", _count_selects)
    try:
        rules = db.query(StreamProtectionRule).filter_by(stream_id=stream_id).all()
        result = protect_batch(events, rules, stream_id=stream_id, db=db)
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", _count_selects)

    assert result.tokenization_batch_items == 5
    assert result.tokenization_created == 5
    assert select_count < 100


def test_tokenization_same_value_stable_token(
    db_session: Session,
    hot_path_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.email",
            sensitivity_class="pii",
            protection_mode="tokenization",
            enabled=True,
            created_by="test",
        )
    )
    db.commit()

    events = [{"email": "same@company.com"} for _ in range(10)]
    rules = db.query(StreamProtectionRule).filter_by(stream_id=stream_id).all()
    result = protect_batch(events, rules, stream_id=stream_id, db=db)
    tokens = {ev["email"] for ev in result.events}
    assert len(tokens) == 1
    assert next(iter(tokens)).startswith("USER_")


def test_tokenization_numeric_id_is_tokenized_not_nulled(
    db_session: Session,
    hot_path_settings: None,
) -> None:
    """F-157: tokenizing a numeric id used to deliver ``null`` (full-mask semantics for non-strings)."""

    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.id",
            sensitivity_class="pii",
            protection_mode="tokenization",
            enabled=True,
            created_by="test",
        )
    )
    db.commit()

    events = [{"id": 6407}, {"id": 6407}, {"id": 6408}, {"id": True}]
    rules = db.query(StreamProtectionRule).filter_by(stream_id=stream_id).all()
    result = protect_batch(events, rules, stream_id=stream_id, db=db)
    first, second, third, flag = (ev["id"] for ev in result.events)
    assert isinstance(first, str) and first
    assert first == second
    assert third != first
    assert "6407" not in first
    # Booleans keep the full-mask semantics; they are not identifiers.
    assert flag is False


def test_get_or_create_tokens_batch_concurrent_race(
    db_session: Session,
    hot_path_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    items = [{"field_path": "$.email", "original_value": "race@company.com"}]

    token_map_a, stats_a = get_or_create_tokens_batch(db, stream_id=stream_id, items=items)
    token_map_b, stats_b = get_or_create_tokens_batch(db, stream_id=stream_id, items=items)
    key = ("$.email", "race@company.com")
    assert token_map_a[key] == token_map_b[key]
    assert stats_a.created == 1
    assert stats_b.cache_hits == 1
    hash_rows = db.execute(
        select(IdentityVaultEntry).where(
            IdentityVaultEntry.stream_id == stream_id,
            IdentityVaultEntry.field_path == "$.email",
        )
    ).scalars().all()
    assert len(hash_rows) == 1
