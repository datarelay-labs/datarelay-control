"""Lab throughput tuning helpers."""

from __future__ import annotations

from app.dev_validation_lab.lab_throughput_config import (
    LAB_ACTIVE_STREAM_TITLES,
    LAB_EPS_MAX,
    LAB_EPS_MIN,
    LAB_HTTP_BASE_PATH,
    LAB_HTTP_HIGH_PATH,
    LAB_HTTP_SINGLE_PATH,
    LAB_FEED_S3_RECORDS_PER_OBJECT,
    LAB_FEED_S3_ROLLING_SLOTS,
    LAB_POLLING_INTERVAL_MIN,
    LAB_POLLING_INTERVAL_NEGATIVE,
    apply_lab_http_throughput_config,
    lab_estimated_eps_for_title,
    lab_estimated_http_eps,
    lab_events_per_poll_for_target,
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
    assert events * 13 / 60.0 >= LAB_EPS_MIN


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
    assert LAB_EPS_MIN <= rates["s3_objects"] * LAB_FEED_S3_RECORDS_PER_OBJECT <= LAB_EPS_MAX
    assert 1 <= rates["remote_files"] <= LAB_EPS_MAX
    assert rates["remote_visible_lines"] == LAB_EPS_MIN * 8


def test_s3_feeder_sustains_acceptance_band_at_slow_live_poll_cycle() -> None:
    rates = lab_feed_tick_rates(high_volume=True)
    events_per_tick = rates["s3_objects"] * LAB_FEED_S3_RECORDS_PER_OBJECT

    # One 20-record object per second minimizes MinIO request contention.
    # The bounded 16-slot ring still carries 320 changed events, enough to clear
    # the 5 EPS floor even if a live poll stretches to a full 60-second window.
    assert LAB_EPS_MIN <= events_per_tick <= LAB_EPS_MAX
    for poll_seconds in (1, 2, 3, 4, 12, 60):
        changed_slots = min(
            LAB_FEED_S3_ROLLING_SLOTS,
            rates["s3_objects"] * poll_seconds,
        )
        eps = changed_slots * LAB_FEED_S3_RECORDS_PER_OBJECT / poll_seconds
        assert eps <= LAB_EPS_MAX
        if poll_seconds == 60:
            assert eps >= LAB_EPS_MIN


def test_webhook_feeder_sustains_acceptance_band_at_slow_live_post_cycle() -> None:
    rates = lab_feed_tick_rates(high_volume=True)
    events_per_post = rates["webhook_events"]

    # A loaded live webhook request can take ~4 seconds end to end. The batch
    # must still clear 5 EPS without exceeding 20 EPS at the normal 1s cycle.
    assert events_per_post / 4.0 >= LAB_EPS_MIN
    assert events_per_post / 1.0 <= LAB_EPS_MAX


def test_visible_remote_file_feeder_sustains_acceptance_band_at_slow_live_poll_cycle() -> None:
    rates = lab_feed_tick_rates(high_volume=True)
    events_per_visible_poll = rates["remote_visible_lines"]

    # Exact-filename lookup avoids the historical full-directory scan.
    # Eight polls in 60 seconds must clear the floor, while 30 polls must stay
    # at or below the ceiling.
    assert events_per_visible_poll * 8 / 60.0 >= LAB_EPS_MIN
    assert events_per_visible_poll * 30 / 60.0 <= LAB_EPS_MAX


def test_wiremock_mappings_include_visible_e2e_receiver() -> None:
    from app.dev_validation_lab.lab_throughput_wiremock import lab_throughput_wiremock_mappings

    receiver = [
        doc
        for doc in lab_throughput_wiremock_mappings()
        if doc.get("request") == {"method": "POST", "urlPath": "/dev-visible-e2e/webhook"}
    ]
    assert len(receiver) == 1
    assert receiver[0]["response"]["status"] == 200
