"""Batch-local inherited protection reuse across multi-route Route Processing ON."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from app.protection.ephemeral import EphemeralProtectionRule
from app.protection.models import (
    PROTECTION_MODE_FULL_MASK,
    PROTECTION_MODE_PARTIAL_MASK,
    PROTECTION_MODE_TOKENIZATION,
)
from app.route_protection.cache_key import protection_execution_cache_key
from app.route_protection.resolver import resolve_route_protection_config
from app.runners.route_context import (
    RouteEffectiveConfig,
    RouteRuntimeContext,
    RouteTransformConfig,
    SharedBatchContext,
)
from app.runners.route_stage import process_route_pipeline, process_routes
from app.runners.route_transform_config import transform_config_cache_key
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII
import app.route_protection.stage as prot_stage


def _stream_rule(
    *,
    field_path: str = "$.email",
    mode: str = PROTECTION_MODE_PARTIAL_MASK,
    stream_id: int = 10,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        stream_id=stream_id,
        field_path=field_path,
        sensitivity_class=SENSITIVITY_CLASS_PII,
        protection_mode=mode,
        enabled=True,
        source_finding_id=None,
    )


def _route_rule(
    *,
    field_path: str = "$.email",
    mode: str = PROTECTION_MODE_FULL_MASK,
    route_id: int = 1,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=route_id * 10,
        route_id=route_id,
        field_path=field_path,
        sensitivity_class=SENSITIVITY_CLASS_PII,
        protection_mode=mode,
        enabled=True,
        source_finding_id=None,
    )


def _stream_transform(**overrides: Any) -> RouteTransformConfig:
    base = {
        "field_mappings": {"email": "$.email", "message": "$.message"},
        "enrichment": {},
        "override_policy": "KEEP_EXISTING",
        "mapping_source": "stream",
        "enrichment_source": "stream",
    }
    base.update(overrides)
    return RouteTransformConfig(**base)


def _make_route(
    route_id: int,
    *,
    transform: RouteTransformConfig | None = None,
    route_protection_rules: list[Any] | None = None,
) -> RouteRuntimeContext:
    metadata: dict[str, Any] = {}
    if route_protection_rules is not None:
        metadata["_route_protection_rules"] = list(route_protection_rules)
    return RouteRuntimeContext(
        route_id=route_id,
        stream_id=10,
        destination_id=100 + route_id,
        route_name=f"route-{route_id}",
        route_type="WEBHOOK_POST",
        formatter={},
        delivery_policy="LOG_AND_CONTINUE",
        rate_limit={},
        metadata=metadata,
        effective_config=RouteEffectiveConfig(
            transform=_stream_transform() if transform is None else transform
        ),
    )


def _shared(
    *,
    batch_id: str = "batch-1",
    events: list[dict[str, Any]] | None = None,
    stream_rules: list[Any] | None = None,
    route_overrides: list[dict[str, Any]] | None = None,
    ephemeral: list[Any] | None = None,
) -> SharedBatchContext:
    drift = None
    if ephemeral is not None:
        drift = SimpleNamespace(ephemeral_protection_rules=list(ephemeral))
    return SharedBatchContext(
        stream_id=10,
        batch_id=batch_id,
        event_root=None,
        union_schema=[],
        extracted_events=events
        or [
            {"email": "alice@example.com", "message": "hello", "common": "value"},
        ],
        schema_observation={},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={
            "stream_protection_rules": list(stream_rules if stream_rules is not None else [_stream_rule()]),
            "route_overrides": list(route_overrides or []),
        },
        schema_drift_policy_result=drift,
    )


def _count_protect_calls(contexts: list[RouteRuntimeContext], shared: SharedBatchContext) -> int:
    with patch.object(prot_stage, "protect_batch", wraps=prot_stage.protect_batch) as mock:
        process_routes(contexts, shared)
        return mock.call_count


def test_protection_cache_key_stable_for_identical_effective_config() -> None:
    stream_rules = [_stream_rule()]
    a = resolve_route_protection_config(route_id=1, stream_id=10, stream_protection_rules=stream_rules)
    b = resolve_route_protection_config(route_id=2, stream_id=10, stream_protection_rules=stream_rules)
    transform_key = transform_config_cache_key(_stream_transform())
    assert protection_execution_cache_key(
        transform_key=transform_key, config=a, merged_ephemeral=[]
    ) == protection_execution_cache_key(transform_key=transform_key, config=b, merged_ephemeral=[])


def test_protection_cache_key_differs_for_override() -> None:
    stream_rules = [_stream_rule()]
    inherited = resolve_route_protection_config(
        route_id=1, stream_id=10, stream_protection_rules=stream_rules
    )
    overridden = resolve_route_protection_config(
        route_id=2,
        stream_id=10,
        stream_protection_rules=stream_rules,
        route_overrides=[
            {
                "route_id": 2,
                "field_path": "$.email",
                "protection_action": "tokenize",
                "enabled": True,
            }
        ],
    )
    transform_key = transform_config_cache_key(_stream_transform())
    assert protection_execution_cache_key(
        transform_key=transform_key, config=inherited, merged_ephemeral=[]
    ) != protection_execution_cache_key(
        transform_key=transform_key, config=overridden, merged_ephemeral=[]
    )


def test_inherited_protection_single_execution_scaling() -> None:
    """Identical inherited protection must not amplify protect_batch with route count."""

    for n in (1, 10, 50, 100):
        contexts = [_make_route(i + 1) for i in range(n)]
        shared = _shared(batch_id=f"scale-{n}")
        calls = _count_protect_calls(contexts, shared)
        assert calls == 1, f"n_routes={n} protect_batch={calls}"
        assert shared.protection_execution_count == 1


def test_inherited_99_plus_one_override_executions() -> None:
    contexts = [_make_route(i + 1) for i in range(99)]
    contexts.append(_make_route(100))
    shared = _shared(
        batch_id="override-1",
        route_overrides=[
            {
                "route_id": 100,
                "field_path": "$.email",
                "protection_action": "mask_full",
                "enabled": True,
            }
        ],
    )
    calls = _count_protect_calls(contexts, shared)
    assert calls == 2
    assert shared.protection_execution_count == 2


def test_distinct_effective_configs_execute_separately() -> None:
    contexts = [
        _make_route(1),
        _make_route(2),
        _make_route(3, route_protection_rules=[_route_rule(mode=PROTECTION_MODE_FULL_MASK)]),
        _make_route(4, route_protection_rules=[_route_rule(field_path="$.absent", mode=PROTECTION_MODE_TOKENIZATION)]),
    ]
    # Use an absent tokenization path so this cache-key unit remains DB-free;
    # persistence-backed string tokenization is covered by scheduler integration tests.
    shared = _shared(
        batch_id="distinct",
        route_overrides=[
            {
                "route_id": 2,
                "field_path": "$.email",
                "protection_action": "hash",
                "enabled": True,
            }
        ],
    )
    calls = _count_protect_calls(contexts, shared)
    # inherited, hash override, full_mask route rules, tokenization route rules
    assert calls == 4
    assert shared.protection_execution_count == 4


def test_same_semantic_route_rules_reuse_across_route_ids() -> None:
    """Route id must not force a cache miss when effective rules are identical."""

    rule_payload = [_route_rule(field_path="$.email", mode=PROTECTION_MODE_FULL_MASK)]
    contexts = [
        _make_route(11, route_protection_rules=rule_payload),
        _make_route(22, route_protection_rules=[_route_rule(field_path="$.email", mode=PROTECTION_MODE_FULL_MASK)]),
    ]
    shared = _shared(batch_id="same-semantic", stream_rules=[])
    calls = _count_protect_calls(contexts, shared)
    assert calls == 1
    assert shared.protection_execution_count == 1


def test_different_transform_prevents_protection_reuse() -> None:
    contexts = [
        _make_route(1, transform=_stream_transform(enrichment={"tag": "a"})),
        _make_route(2, transform=_stream_transform(enrichment={"tag": "b"})),
    ]
    shared = _shared(batch_id="diff-transform")
    calls = _count_protect_calls(contexts, shared)
    assert calls == 2
    assert shared.protection_execution_count == 2


def test_protection_disabled_empty_rules_still_scales_to_one() -> None:
    contexts = [_make_route(i + 1) for i in range(10)]
    shared = _shared(batch_id="empty", stream_rules=[])
    calls = _count_protect_calls(contexts, shared)
    assert calls == 1
    assert shared.protection_execution_count == 1


def test_route_event_object_isolation_with_shared_protection() -> None:
    shared = _shared(batch_id="iso")
    route_a = _make_route(1)
    route_b = _make_route(2)

    result_a = process_route_pipeline(route_a, shared)
    assert result_a.events
    original_b_email_before = "alice@example.com"
    result_a.events[0]["email"] = "mutated-by-A"
    result_a.events[0]["common"] = "mutated-by-A"
    result_a.events[0]["route"] = "A"

    result_b = process_route_pipeline(route_b, shared)
    assert result_b.events
    assert result_b.events[0] is not result_a.events[0]
    assert result_b.events[0].get("route") != "A"
    assert result_b.events[0].get("common") == "value"
    assert result_b.events[0].get("email") != "mutated-by-A"
    assert result_a.events[0].get("email") == "mutated-by-A"
    # Protected value still applied on B (partial mask of plaintext)
    assert result_b.events[0].get("email") != original_b_email_before
    assert shared.protection_execution_count == 1

    # Cached canonical events must also remain untouched by route A mutations.
    cached = next(iter(shared.protection_result_cache.values()))
    assert cached.events[0].get("email") != "mutated-by-A"
    assert cached.events[0].get("common") == "value"


def test_classification_receives_route_local_protected_copy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.route_classification.stage.classification_enabled", lambda: True)
    monkeypatch.setattr("app.classification.engine.classification_enabled", lambda: True)

    shared = _shared(batch_id="class-iso")
    route_a = _make_route(1)
    route_b = _make_route(2)

    seen_ids: list[int] = []
    original = __import__(
        "app.route_classification.stage", fromlist=["classify_batch"]
    ).classify_batch

    def _wrap(events: list[dict[str, Any]], **kwargs: Any) -> Any:
        assert events
        seen_ids.append(id(events[0]))
        events[0]["_mutated_by_classification"] = f"id-{id(events[0])}"
        return original(events, **kwargs)

    with patch("app.route_classification.stage.classify_batch", side_effect=_wrap):
        result_a = process_route_pipeline(route_a, shared)
        result_b = process_route_pipeline(route_b, shared)

    assert len(seen_ids) == 2
    assert seen_ids[0] != seen_ids[1]
    assert result_a.events[0].get("_mutated_by_classification") != result_b.events[0].get(
        "_mutated_by_classification"
    )
    assert shared.protection_execution_count == 1


def test_multi_batch_does_not_reuse_across_batches() -> None:
    contexts = [_make_route(1), _make_route(2)]
    batch1 = _shared(batch_id="b1")
    batch2 = _shared(batch_id="b2")
    assert _count_protect_calls(contexts, batch1) == 1
    assert _count_protect_calls(contexts, batch2) == 1
    assert batch1.protection_execution_count == 1
    assert batch2.protection_execution_count == 1


def test_ephemeral_rules_included_in_reuse_key() -> None:
    ephemeral = [
        EphemeralProtectionRule(
            stream_id=10,
            field_path="$.ssn",
            protection_mode=PROTECTION_MODE_FULL_MASK,
            sensitivity_class=SENSITIVITY_CLASS_PII,
        )
    ]
    contexts = [_make_route(1), _make_route(2)]
    shared = _shared(batch_id="eph", ephemeral=ephemeral)
    calls = _count_protect_calls(contexts, shared)
    assert calls == 1
    assert shared.protection_execution_count == 1


def test_protection_failure_warning_semantics_preserved() -> None:
    """Invalid path still runs protect_batch once; reused routes get same warning metrics."""

    contexts = [_make_route(i + 1) for i in range(5)]
    shared = _shared(
        batch_id="warn",
        stream_rules=[_stream_rule(field_path="$.missing.path")],
    )
    with patch.object(prot_stage, "protect_batch", wraps=prot_stage.protect_batch) as mock:
        results = process_routes(contexts, shared)
        assert mock.call_count == 1
    assert shared.protection_execution_count == 1
    assert len(results.stage_results) == 5
    for stage in results.stage_results:
        prot_entry = next(e for e in stage.stage_timeline if e.get("stage") == "protection")
        assert prot_entry.get("rules_applied") == 1
