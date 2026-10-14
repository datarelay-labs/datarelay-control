"""M3-03/04/05/06/09: actual saved Route preview, no sender or persistence."""
from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.destinations.models import Destination
from app.main import app
from app.protection.models import StreamPolicyRule
from app.routes.models import Route
from app.runtime import preview_service
from app.runtime.schemas import RouteDeliveryPreviewRequest
from tests.test_stream_runner_e2e import _seed_stream_runtime


def _payload(seed: dict[str, Any], route_index: int = 0) -> dict[str, Any]:
    return {
        'payload': {'items': [{'id': 'ux-event-1', 'message': 'synthetic event', 'vendor': 'Acme'}]},
        'event_array_path': '$.items',
        'stream_id': seed['stream_id'],
        'route_id': seed['route_ids'][route_index],
        'destination_type': 'WEBHOOK_POST',  # Legacy caller hint must not override a saved Syslog Route.
        'field_mappings': {'wrong_draft_mapping': '$.absent'},
        'enrichment': {'not_saved': True},
        'max_events': 3,
    }


def test_saved_route_uses_its_own_sender_formatter_and_native_stage_events(db_session: Session) -> None:
    seed = _seed_stream_runtime(db_session, failure_policies=['LOG_AND_CONTINUE', 'LOG_AND_CONTINUE'])
    destination = db_session.get(Destination, seed['destination_ids'][0])
    assert destination is not None
    destination.destination_type = 'SYSLOG_UDP'
    destination.config_json = {'host': '127.0.0.1', 'port': 5514}
    route = db_session.get(Route, seed['route_ids'][0])
    assert route is not None
    route.formatter_config_json = {'message_prefix_enabled': True, 'message_prefix_template': 'UX-NATIVE-PREFIX '}
    db_session.commit()
    client = TestClient(app)
    result = client.post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed))
    assert result.status_code == 200, result.text
    body = result.json()
    assert body['configuration_state'] == 'saved'
    assert body['destination_type'] == 'SYSLOG_UDP'
    assert body['destination_id'] == destination.id
    assert list(body['stage_previews']) == ['input', 'mapping', 'transform', 'protection', 'classification', 'policy', 'destination']
    assert body['mapped_events'][0] == {'event_id': 'ux-event-1', 'message': 'synthetic event', 'vendor': 'Acme'}
    assert body['stage_previews']['mapping'] == body['mapped_events']
    assert body['stage_previews']['transform'][0]['product'] == 'GDC'
    assert body['stage_previews']['classification'][0]['classification_level'] == 'INTERNAL'
    assert body['stage_previews']['policy'] == body['final_events']
    expected = preview_service.run_route_delivery_preview(db_session, RouteDeliveryPreviewRequest(route_id=route.id, events=body['final_events']))
    assert body['preview_messages'] == expected.preview_messages
    assert body['preview_messages'][0].startswith('UX-NATIVE-PREFIX')
    assert body['stage_previews']['destination'] == body['preview_messages']
    other = client.post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed, 1)).json()
    assert other['destination_type'] == 'WEBHOOK_POST'
    assert other['destination_id'] != body['destination_id']
    assert other['preview_messages'] == other['final_events']


def test_saved_route_does_not_evaluate_a_second_unbound_draft(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    seed = _seed_stream_runtime(db_session)
    def fail_if_draft_evaluated(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError('A saved Route preview must execute the native Route pipeline once, not a separate draft first.')
    monkeypatch.setattr(preview_service, 'run_final_event_draft_preview', fail_if_draft_evaluated)
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed))
    assert response.status_code == 200, response.text
    assert response.json()['mapped_events'][0]['event_id'] == 'ux-event-1'


def test_saved_route_resolves_destination_without_a_fake_client_type(db_session: Session) -> None:
    seed = _seed_stream_runtime(db_session)
    payload = _payload(seed)
    del payload['destination_type']
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=payload)
    assert response.status_code == 200, response.text
    assert response.json()['destination_type'] == 'WEBHOOK_POST'


def test_saved_route_preview_does_not_send_or_write_checkpoint_config_or_logs(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    seed = _seed_stream_runtime(db_session)
    before = deepcopy(db_session.query(Checkpoint).filter_by(stream_id=seed['stream_id']).one().checkpoint_value_json)
    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError('No sender or commit is permitted in preview')
    monkeypatch.setattr('app.delivery.syslog_sender.SyslogSender.send', forbidden)
    monkeypatch.setattr('app.delivery.webhook_sender.WebhookSender.send', forbidden)
    monkeypatch.setattr(Session, 'commit', forbidden)
    writes: list[str] = []
    engine = db_session.get_bind()
    def observe(connection: Any, cursor: Any, statement: str, parameters: Any, context: Any, executemany: bool) -> None:
        if statement.lstrip().split(' ', 1)[0].lower() in {'insert', 'update', 'delete', 'drop', 'alter', 'truncate'}:
            writes.append(statement)
    event.listen(engine, 'before_cursor_execute', observe)
    try:
        response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed))
    finally:
        event.remove(engine, 'before_cursor_execute', observe)
    assert response.status_code == 200, response.text
    assert writes == []
    db_session.expire_all()
    assert db_session.query(Checkpoint).filter_by(stream_id=seed['stream_id']).one().checkpoint_value_json == before


def test_saved_route_trace_masks_secret_fields_but_preserves_business_data(db_session: Session) -> None:
    seed = _seed_stream_runtime(db_session)
    payload = _payload(seed)
    payload['payload']['items'][0]['api_key'] = 'synthetic-secret-never-display'
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['display_redacted'] is True
    assert 'synthetic-secret-never-display' not in response.text
    assert body['stage_previews']['input'][0]['message'] == 'synthetic event'


def test_preview_payload_cap_is_enforced_before_evaluation(db_session: Session) -> None:
    seed = _seed_stream_runtime(db_session)
    payload = _payload(seed)
    payload['payload'] = {'too_large': 'x' * 1_048_577}
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=payload)
    assert response.status_code == 413
    assert response.json()['detail']['error_code'] == 'PREVIEW_SAMPLE_TOO_LARGE'


def test_quarantine_preview_preserves_decision_without_persisting(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    seed = _seed_stream_runtime(db_session)
    db_session.add(StreamPolicyRule(stream_id=seed['stream_id'], name='ux-quarantine', enabled=True,
        condition_json={'classification_level': 'INTERNAL'}, action_type='quarantine'))
    db_session.commit()
    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError('Preview must not create a quarantine record or invoke a sender')
    monkeypatch.setattr('app.route_policy.stage.record_route_policy_quarantine_event', forbidden)
    monkeypatch.setattr('app.delivery.webhook_sender.WebhookSender.send', forbidden)
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['delivery_allowed'] is False
    assert body['policy_action'] == 'quarantine'
    assert body['final_events'] == body['preview_messages'] == []
    assert body['stage_previews']['classification'][0]['classification_level'] == 'INTERNAL'
    assert body['stage_previews']['policy'] == []
    policy = next(item for item in body['route_stage_timeline'] if item['stage'] == 'policy')
    assert policy['quarantine_recorded'] is False


def test_tokenizing_preview_is_explicitly_unavailable_without_vault_writes(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.protection.models import StreamProtectionRule, IdentityVaultEntry
    seed = _seed_stream_runtime(db_session)
    db_session.add(StreamProtectionRule(stream_id=seed['stream_id'], field_path='message', sensitivity_class='pii',
        protection_mode='tokenization', enabled=True, created_by='test'))
    db_session.commit()
    before = db_session.query(IdentityVaultEntry).count()
    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError('Tokenization preview must not enter the persistence engine')
    monkeypatch.setattr('app.route_protection.stage.protect_batch', forbidden)
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed))
    assert response.status_code == 409
    assert response.json()['detail']['error_code'] == 'PREVIEW_PERSISTENCE_REQUIRED'
    assert response.json()['detail']['stage'] == 'protection'
    assert db_session.query(IdentityVaultEntry).count() == before


def test_route_masking_is_isolated_and_captured_before_after_are_not_aliased(db_session: Session) -> None:
    from app.route_protection.models import RouteProtectionRule
    seed = _seed_stream_runtime(db_session, failure_policies=['LOG_AND_CONTINUE', 'LOG_AND_CONTINUE'])
    db_session.add(RouteProtectionRule(route_id=seed['route_ids'][0], field_path='message', sensitivity_class='pii',
        protection_mode='full_mask', enabled=True))
    db_session.commit()
    client = TestClient(app)
    first = client.post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed))
    assert first.status_code == 200, first.text
    stages = first.json()['stage_previews']
    assert stages['transform'][0]['message'] == 'synthetic event'
    assert stages['protection'][0]['message'] != 'synthetic event'
    second = client.post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed, 1))
    assert second.status_code == 200, second.text
    assert second.json()['stage_previews']['protection'][0]['message'] == 'synthetic event'


def test_unbound_draft_still_requires_destination_type() -> None:
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json={'payload': {'id': 1}})
    assert response.status_code == 422


def test_renamed_known_secret_cannot_leak_through_a_stage_or_formatted_payload(db_session: Session) -> None:
    from app.mappings.models import Mapping
    seed = _seed_stream_runtime(db_session)
    mapping = db_session.query(Mapping).filter_by(stream_id=seed['stream_id']).one()
    mapping.field_mappings_json = {'event_id': '$.id', 'renamed': '$.api_key', 'message': '$.message'}
    db_session.commit()
    payload = _payload(seed)
    payload['payload']['items'][0]['api_key'] = 'synthetic-secret-to-rename'
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=payload)
    assert response.status_code == 200, response.text
    assert 'synthetic-secret-to-rename' not in response.text
    assert response.json()['mapped_events'][0]['renamed'] == '********'
    assert response.json()['mapped_events'][0]['message'] == 'synthetic event'


def test_saved_route_evaluation_error_is_actionable_and_not_a_success(db_session: Session) -> None:
    from app.mappings.models import Mapping
    seed = _seed_stream_runtime(db_session)
    mapping = db_session.query(Mapping).filter_by(stream_id=seed['stream_id']).one()
    mapping.field_mappings_json = {'event_id': '$['}
    db_session.commit()
    response = TestClient(app, raise_server_exceptions=False).post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed))
    assert response.status_code == 422
    assert response.json()['detail']['error_code'] == 'ROUTE_PREVIEW_STAGE_FAILED'
    assert 'final_events' not in response.json()


@pytest.mark.parametrize('stage', ['mapping', 'enrichment'])
def test_real_field_warning_is_visible_without_raw_error_or_sample(stage: str, db_session: Session) -> None:
    from app.route_transform.models import RouteMapping, RouteEnrichment
    seed = _seed_stream_runtime(db_session)
    rule = {'rule_id': 'ux-no-match', 'mode': 'regex_extract', 'output_field': 'source_ip',
        'source_path': '$.message', 'pattern': r'src=(\d+\.\d+\.\d+\.\d+)', 'group': 1}
    if stage == 'mapping':
        db_session.add(RouteMapping(route_id=seed['route_ids'][0], field_mappings_json={
            'message': '$.message', 'transform_rules': [rule]}))
    else:
        db_session.add(RouteEnrichment(route_id=seed['route_ids'][0],
            enrichment_json={'advanced_fields': [rule]}, override_policy='KEEP_EXISTING', enabled=True))
    db_session.commit()
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=_payload(seed))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['preview_issue_count'] == 1
    assert body['preview_issues_truncated'] is False
    assert body['preview_issues'] == [{'stage': stage, 'rule_id': 'ux-no-match',
        'output_field': 'source_ip', 'error_code': 'REGEX_NO_MATCH'}]
    assert 'sample_value' not in body['preview_issues'][0]
    assert 'error_message' not in body['preview_issues'][0]
    assert 'with field warnings' in body['message']


def test_many_field_warnings_are_bounded_but_not_declared_complete(db_session: Session) -> None:
    from app.route_transform.models import RouteMapping
    seed = _seed_stream_runtime(db_session)
    rules = [{'rule_id': f'ux-no-match-{index}', 'mode': 'regex_extract', 'output_field': f'field_{index}',
        'source_path': '$.message', 'pattern': r'src=(\d+)', 'group': 1} for index in range(40)]
    db_session.add(RouteMapping(route_id=seed['route_ids'][0], field_mappings_json={
        'message': '$.message', 'transform_rules': rules}))
    db_session.commit()
    payload = _payload(seed)
    payload['payload']['items'] *= 3
    response = TestClient(app).post('/api/v1/runtime/preview/e2e-draft', json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['preview_issue_count'] == 120
    assert len(body['preview_issues']) == 100
    assert body['preview_issues_truncated'] is True
