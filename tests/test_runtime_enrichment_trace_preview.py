from __future__ import annotations

from fastapi.testclient import TestClient

from app.enrichers.rule_executor import execute_enrichment
from app.main import app
from app.runtime.preview_service import run_enrichment_trace_preview
from app.runtime.schemas import EnrichmentTracePreviewRequest


ENRICHMENT = {
    "vendor": "Acme",
    "__rules": {
        "metadata.label": {
            "type": "calculated",
            "expression": "concat({{vendor}}, '-', {{code}})",
            "enabled": True,
        },
        "metadata.code_upper": {
            "type": "normalize",
            "source_field": "code",
            "format": "uppercase",
            "enabled": True,
        },
    },
}


def test_enrichment_trace_preserves_runtime_order_and_aggregates_samples() -> None:
    result = run_enrichment_trace_preview(
        EnrichmentTracePreviewRequest(
            mapped_events=[{"code": "abc"}, {"code": "xyz"}],
            enrichment=ENRICHMENT,
        )
    )

    assert result.preview_event_count == 2
    assert result.rule_count == 3
    assert [(row.rule_type, row.target_field) for row in result.rule_summaries] == [
        ("static", "vendor"),
        ("calculated", "metadata.label"),
        ("normalize", "metadata.code_upper"),
    ]
    assert [row.changed_count for row in result.rule_summaries] == [2, 2, 2]
    assert result.samples[0].output_event["vendor"] == "Acme"
    assert result.samples[0].output_event["metadata"]["label"] == "Acme-abc"
    assert result.samples[0].output_event["metadata"]["code_upper"] == "ABC"
    assert result.samples[1].output_event["metadata"]["label"] == "Acme-xyz"


def test_enrichment_trace_through_step_returns_event_at_selected_rule() -> None:
    result = run_enrichment_trace_preview(
        EnrichmentTracePreviewRequest(
            mapped_events=[{"code": "abc"}],
            enrichment=ENRICHMENT,
            through_step=1,
        )
    )

    assert result.rule_count == 2
    assert [row.step_index for row in result.rule_summaries] == [0, 1]
    assert result.samples[0].output_event["metadata"]["label"] == "Acme-abc"
    assert "code_upper" not in result.samples[0].output_event["metadata"]


def test_enrichment_trace_conflict_marks_error_and_blocks_downstream_rule() -> None:
    result = run_enrichment_trace_preview(
        EnrichmentTracePreviewRequest(
            mapped_events=[{"vendor": "Existing", "code": "abc"}],
            enrichment=ENRICHMENT,
            override_policy="ERROR_ON_CONFLICT",
        )
    )

    assert result.rule_summaries[0].error_count == 1
    assert result.rule_summaries[0].failed_sample_indices == [0]
    assert result.rule_summaries[1].blocked_count == 1
    assert result.rule_summaries[1].failed_sample_indices == []
    assert result.rule_summaries[2].blocked_count == 1
    assert result.rule_summaries[2].failed_sample_indices == []
    assert result.samples[0].failed_step_index == 0
    assert result.samples[0].output_event["vendor"] == "Existing"
    assert "metadata" not in result.samples[0].output_event


def test_enrichment_trace_warning_is_runtime_warning() -> None:
    enrichment = {
        "__rules": {
            "metadata.region_name": {
                "type": "lookup",
                "lookup_table": "aws_regions",
                "lookup_key_field": "region",
                "enabled": True,
            }
        }
    }
    result = run_enrichment_trace_preview(
        EnrichmentTracePreviewRequest(
            mapped_events=[{"region": "unknown-region-xyz"}],
            enrichment=enrichment,
        )
    )

    assert result.rule_summaries[0].warning_count == 1
    assert result.samples[0].steps[0].warning_codes == ["lookup_miss"]
    assert result.samples[0].steps[0].changed is False


def test_enrichment_trace_http_endpoint_is_read_only_and_returns_trace() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/enrichment-trace",
        json={
            "mapped_events": [{"code": "abc"}],
            "enrichment": ENRICHMENT,
            "through_step": 1,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["through_step"] == 1
    assert body["rule_count"] == 2
    assert body["samples"][0]["output_event"]["metadata"]["label"] == "Acme-abc"


def test_enrichment_trace_matches_runtime_and_tracks_nested_static_target() -> None:
    enrichment = {
        "metadata.tenant": "acme",
        "__rules": {
            "metadata.label": {
                "type": "calculated",
                "expression": "concat({{metadata.tenant}}, '-', {{code}})",
                "enabled": True,
            }
        },
    }
    event = {"code": "evt"}

    traced = run_enrichment_trace_preview(
        EnrichmentTracePreviewRequest(mapped_events=[event], enrichment=enrichment)
    )
    runtime = execute_enrichment(event, enrichment, emit_logs=False)

    assert traced.samples[0].output_event == runtime.event
    assert traced.samples[0].steps[0].target_field == "metadata.tenant"
    assert traced.samples[0].steps[0].before_present is False
    assert traced.samples[0].steps[0].after_present is True
    assert traced.samples[0].steps[0].after_value == "acme"
    assert traced.samples[0].steps[0].changed is True


def test_enrichment_trace_http_endpoint_rejects_more_than_twenty_samples() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/enrichment-trace",
        json={
            "mapped_events": [{"code": str(index)} for index in range(21)],
            "enrichment": ENRICHMENT,
        },
    )

    assert response.status_code == 422
