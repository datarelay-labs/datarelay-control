"""An opt-in Grant-protected delivery log must never reach the old send path."""

from types import SimpleNamespace

import pytest

from app.runtime import replay_service
from app.runtime.grant_replay_dispatch import ProtectedReplayDenied


class _Query:
    def filter(self, *_args):
        return self

    def first(self):
        return SimpleNamespace(id=42,route_id=7,destination_id=9)


class _Session:
    def query(self, *_args):
        return _Query()

    def get_bind(self):
        return object()


@pytest.mark.parametrize('dry_run',[False,True])
def test_native_replay_service_guard_runs_before_eligibility_or_any_send(monkeypatch,dry_run):
    calls=[]
    class _Inspector:
        def has_table(self, table):
            calls.append(('table',table))
            return True
    monkeypatch.setattr('sqlalchemy.inspect',lambda _bind:_Inspector())
    def deny(_db,_row,*,protected_permit,dry_run):
        calls.append(('deny',dry_run))
        raise ProtectedReplayDenied()
    monkeypatch.setattr('app.runtime.grant_replay_dispatch.enforce_native_replay_boundary',deny)
    monkeypatch.setattr(replay_service,'assess_replay_eligibility',lambda *_:pytest.fail('guard must be first'))
    with pytest.raises(ProtectedReplayDenied,match='GRANT_PROTECTED_REPLAY_REQUIRED'):
        replay_service.replay_delivery_log(_Session(),42,dry_run=dry_run)
    assert ('deny',dry_run) in calls


def test_missing_ledger_table_rejects_product_armed_permit(monkeypatch):
    class _Inspector:
        def has_table(self,_name):
            return False
    monkeypatch.setattr('sqlalchemy.inspect',lambda _bind:_Inspector())
    monkeypatch.setattr(replay_service,'assess_replay_eligibility',lambda *_:pytest.fail('cannot bypass absent ledger'))
    with pytest.raises(ProtectedReplayDenied):
        replay_service.replay_delivery_log(_Session(),42,protected_permit=object())


def test_native_service_rejects_persistently_protected_log_without_product_permit(monkeypatch,tmp_path):
    """Native send is not entered for a log protected by the real product ledger."""
    import uuid
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.logs.models import DeliveryLog
    from app.runtime.grant_replay_ledger import GrantProtectedReplayLedger,ReplayBinding,reserve
    from app.runtime.grant_replay_dispatch import arm_protected_dispatch_once

    engine=create_engine(f"sqlite:///{tmp_path / 'protected-source.db'}")
    GrantProtectedReplayLedger.__table__.create(engine)
    factory=sessionmaker(bind=engine,expire_on_commit=False)
    binding=ReplayBinding(
        operation_key='native-source-log-42',grant_request_id=str(uuid.uuid4()),
        execution_id='fixed-execution-42',action_hash='a'*64,
        delivery_log_id=42,route_id=7,destination_id=9,
    )
    assert reserve(factory,binding)=='NEW_RESERVATION'

    class DB:
        def __init__(self,session):
            self.session=session
        def query(self,model):
            if model is DeliveryLog:
                return _Query()
            return self.session.query(model)
        def get_bind(self):
            return self.session.get_bind()

    with factory() as session:
        wrapped=DB(session)
        monkeypatch.setattr(replay_service,'assess_replay_eligibility',lambda *_:pytest.fail('blocked before stage/send'))
        with pytest.raises(ProtectedReplayDenied):
            replay_service.replay_delivery_log(wrapped,42)
        with pytest.raises(ProtectedReplayDenied):
            replay_service.replay_delivery_log(wrapped,42,dry_run=True)
        permit=arm_protected_dispatch_once(factory,binding)
        assert permit is not None
        class _GuardPass(Exception):
            pass
        def after_verified_guard(*_):
            raise _GuardPass('no actual replay/send')
        monkeypatch.setattr(replay_service,'assess_replay_eligibility',after_verified_guard)
        with pytest.raises(_GuardPass,match='no actual replay'):
            replay_service.replay_delivery_log(wrapped,42,protected_permit=permit)
        with pytest.raises(ProtectedReplayDenied):
            replay_service.replay_delivery_log(wrapped,42,protected_permit=permit)
    engine.dispose()


@pytest.mark.parametrize('dry_run', [False, True])
def test_existing_operator_replay_http_handler_refuses_protected_log_before_audit(monkeypatch, dry_run):
    """The native operator route must expose a sanitized 409, never permit a send."""
    import asyncio

    from fastapi import HTTPException

    from app.runtime import router
    from app.runtime.schemas import DeliveryLogReplayRequest

    calls = []

    def denied(_db, log_id, *, dry_run):
        calls.append((log_id, dry_run))
        raise ProtectedReplayDenied()

    def unexpected_audit(*_args, **_kwargs):
        pytest.fail('blocked HTTP replay must not create an execution audit event')

    monkeypatch.setattr(router.replay_service, 'replay_delivery_log', denied)
    monkeypatch.setattr(router.journal, 'record_audit_event', unexpected_audit)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(router.replay_failed_delivery_log(
            log_id=42, request=object(),
            payload=DeliveryLogReplayRequest(dry_run=dry_run), db=object(),
        ))
    assert caught.value.status_code == 409
    assert caught.value.detail['error_code'] == 'GRANT_PROTECTED_REPLAY_REQUIRED'
    assert 'product-verified' in caught.value.detail['message']
    assert calls == [(42, dry_run)]
