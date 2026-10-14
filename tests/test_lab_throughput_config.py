"""Lab throughput tuning helpers."""

from __future__ import annotations

from app.dev_validation_lab.lab_throughput_config import (
    LAB_ACTIVE_STREAM_TITLES,
    LAB_EPS_MAX,
    LAB_EPS_MIN,
    LAB_HTTP_BASE_PATH,
    LAB_HTTP_HIGH_PATH,
    LAB_HTTP_SINGLE_PATH,
    LAB_POLLING_INTERVAL_NEGATIVE,
    apply_lab_http_throughput_config,
    lab_estimated_eps_for_title,
    lab_estimated_http_eps,
    lab_feed_tick_rates,
    lab_http_endpoint_for_stream,
    lab_http_eps_within_target,
    lab_http_events_for_path,
    lab_polling_interval_for_title,
    lab_target_eps_for_bare_title,
)


def test_every_active_stream_has_unique_random_target_eps() -> None:
    targets = {lab_target_eps_for_bare_title(title) for title in LAB_ACTIVE_STREAM_TITLES}
    assert min(targets) >= LAB_EPS_MIN
    assert max(targets) <= LAB_EPS_MAX
    assert len(targets) > 1


def test_active_streams_estimated_eps_within_band() -> None:
    prefixes = ("[DEV VALIDATION] ", "[DEV E2E] ")
    for bare in sorted(LAB_ACTIVE_STREAM_TITLES):
        for prefix in prefixes:
            title = f"{prefix}{bare}"
            if bare.startswith("Stream ") and prefix == "[DEV E2E] " and bare not in {
                "HTTP API Stream",
                "S3 Object Stream",
                "Database Query Stream",
                "Remote File Stream",
                "Webhook Receiver Stream",
            }:
                continue
            if prefix == "[DEV VALIDATION] " and bare in {
                "HTTP API Stream",
                "S3 Object Stream",
                "Database Query Stream",
                "Remote File Stream",
                "Webhook Receiver Stream",
            }:
                continue
            assert lab_http_eps_within_target(title, prefix=prefix), title
            eps = lab_estimated_eps_for_title(title, prefix=prefix)
            assert eps is not None
            assert LAB_EPS_MIN <= eps <= LAB_EPS_MAX, (title, eps)


def test_negative_streams_keep_slow_polling() -> None:
    prefix = "[DEV VALIDATION] "
    assert lab_polling_interval_for_title(f"{prefix}Stream empty-response", prefix=prefix) == LAB_POLLING_INTERVAL_NEGATIVE
    assert lab_estimated_eps_for_title(f"{prefix}Stream empty-response", prefix=prefix) is None


def test_lab_http_endpoint_mapping() -> None:
    prefix = "[DEV VALIDATION] "
    assert lab_http_endpoint_for_stream(
        f"{prefix}Stream array-response",
        prefix=prefix,
        current_endpoint="/api/v1/e2e-auth/no-auth-events",
    ) == LAB_HTTP_HIGH_PATH
    assert lab_http_endpoint_for_stream(
        f"{prefix}Stream single-object",
        prefix=prefix,
        current_endpoint="/api/v1/e2e-data/single-object",
    ) == LAB_HTTP_SINGLE_PATH
    assert lab_http_endpoint_for_stream(
        f"{prefix}Stream empty-response",
        prefix=prefix,
        current_endpoint="/api/v1/e2e-data/empty-array",
    ) == "/api/v1/e2e-data/empty-array"


def test_shared_high_http_stub_stays_within_live_eps_band() -> None:
    events = lab_http_events_for_path(LAB_HTTP_HIGH_PATH)
    eps = lab_estimated_http_eps(events_per_poll=events, polling_interval_seconds=1)
    assert LAB_EPS_MIN <= eps <= LAB_EPS_MAX


def test_apply_lab_http_throughput_config() -> None:
    prefix = "[DEV VALIDATION] "
    out = apply_lab_http_throughput_config(
        {"endpoint": "/api/v1/e2e-auth/no-auth-events", "method": "GET"},
        stream_title=f"{prefix}Stream array-response",
        prefix=prefix,
    )
    assert out["endpoint"] == LAB_HTTP_HIGH_PATH
    assert out["method"] == "GET"


def test_lab_webhook_destination_uses_batch_delivery() -> None:
    from app.dev_validation_lab.lab_throughput_config import (
        LAB_WEBHOOK_BATCH_SIZE,
        LAB_WEBHOOK_PAYLOAD_MODE,
        lab_webhook_destination_config_patch,
    )

    out = lab_webhook_destination_config_patch({"url": "http://example/webhook"})
    assert out["payload_mode"] == LAB_WEBHOOK_PAYLOAD_MODE
    assert out["batch_size"] == LAB_WEBHOOK_BATCH_SIZE


def test_feeder_tick_rates_are_per_second_and_bounded() -> None:
    rates = lab_feed_tick_rates(high_volume=True)
    assert LAB_EPS_MIN <= rates["db_rows"] <= LAB_EPS_MAX
    assert LAB_EPS_MIN <= rates["webhook_events"] <= LAB_EPS_MAX
    assert 1 <= rates["s3_objects"] <= LAB_EPS_MAX
    assert 1 <= rates["remote_files"] <= LAB_EPS_MAX
    assert LAB_EPS_MIN <= rates["remote_visible_lines"] <= LAB_EPS_MAX


def test_wiremock_mappings_include_visible_e2e_receiver() -> None:
    from app.dev_validation_lab.lab_throughput_wiremock import lab_throughput_wiremock_mappings

    receiver = [
        doc
        for doc in lab_throughput_wiremock_mappings()
        if doc.get("request") == {"method": "POST", "urlPath": "/dev-visible-e2e/webhook"}
    ]
    assert len(receiver) == 1
    assert receiver[0]["response"]["status"] == 200
