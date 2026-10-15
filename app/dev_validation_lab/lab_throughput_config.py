"""Throughput targets for dev-validation and visible E2E lab streams.

Every active (non-negative) lab stream gets a stable pseudo-random sustained EPS target
in ``[LAB_EPS_MIN, LAB_EPS_MAX]``. Polling intervals, WireMock batch sizes, and feeder
tick rates are derived from those targets so the stream console shows ≥5 EPS per stream.
"""

from __future__ import annotations

import math
import random
import zlib
from typing import Any

# Sustained EPS band for dashboard / stream-console lab fixtures.
LAB_EPS_MIN = 5
LAB_EPS_MAX = 20

# Legacy aliases (tests / callers).
LAB_EPS_MAX_EXCLUSIVE = LAB_EPS_MAX + 1

# Polling cadence bounds and negative-test slow path.
LAB_POLLING_INTERVAL_MIN = 1
LAB_POLLING_INTERVAL_MAX = 4
LAB_POLLING_INTERVAL_NEGATIVE = 120

# Current isolated StreamRunner cycles complete in a few hundred milliseconds for the lab HTTP path.
# EPS must use events / (run_duration + polling_interval), not events / polling_interval alone.
LAB_EXPECTED_RUN_DURATION_SEC = 0.25
LAB_MAX_EVENTS_PER_POLL = 300

# Lab webhook destinations deliver one HTTP POST per poll batch (not per event).
LAB_WEBHOOK_PAYLOAD_MODE = "BATCH_JSON_ARRAY"
LAB_WEBHOOK_BATCH_SIZE = 300

# Legacy tier constants (kept for importers; prefer per-stream helpers below).
LAB_POLLING_INTERVAL_BASE = 2
LAB_POLLING_INTERVAL_HIGH = 1
LAB_POLLING_INTERVAL_SINGLE_EVENT = 1

# WireMock batch size per lab-throughput HTTP path (≥ LAB_EPS_MAX for interval=1 streams).
LAB_HTTP_EVENTS_BASE = 20
LAB_HTTP_EVENTS_HIGH = 20
LAB_HTTP_EVENTS_NESTED = 20
LAB_HTTP_EVENTS_OKTA = 20
LAB_HTTP_EVENTS_SINGLE = 20

# Feeder tick batch sizes — scaled to sustain the highest DB / webhook / object targets.
LAB_FEED_DB_ROWS_BASE = 8
LAB_FEED_DB_ROWS_HIGH = 20
LAB_FEED_S3_OBJECTS_BASE = 2
LAB_FEED_S3_OBJECTS_HIGH = 4
LAB_FEED_REMOTE_FILES_BASE = 2
LAB_FEED_REMOTE_FILES_HIGH = 4
LAB_FEED_WEBHOOK_EVENTS_BASE = 8
LAB_FEED_WEBHOOK_EVENTS_HIGH = 20
LAB_FEED_REMOTE_VISIBLE_LINES = 20

LAB_HTTP_BASE_PATH = "/api/v1/lab-throughput/base-events"
LAB_HTTP_HIGH_PATH = "/api/v1/lab-throughput/high-events"
LAB_HTTP_SINGLE_PATH = "/api/v1/lab-throughput/single-object"
LAB_HTTP_NESTED_PATH = "/api/v1/lab-throughput/nested-array"
LAB_HTTP_OKTA_LOGS_PATH = "/api/v1/lab-throughput/okta-logs"

_VISIBLE_E2E_PREFIX = "[DEV E2E] "
_VALIDATION_PREFIX = "[DEV VALIDATION] "

# Bare stream titles (without lab prefix) that receive sustained throughput.
LAB_ACTIVE_STREAM_TITLES: frozenset[str] = frozenset(
    {
        # DEV VALIDATION — HTTP
        "Stream single-object",
        "Stream array-response",
        "Stream nested-array",
        "Stream post-json-body",
        "Stream pagination-sample",
        "Stream delivery-only",
        "Stream vendor-malop",
        "Stream OAuth2 client-credentials",
        "Stream OAuth2 refresh-cycle (JWT token URL)",
        "Stream session-events",
        # DEV VALIDATION — source expansion
        "Database Query PostgreSQL E2E",
        "Database Query MySQL E2E",
        "Database Query MariaDB E2E",
        "Remote File SFTP E2E",
        "Remote File SCP JSON E2E",
        "S3 Object Polling E2E",
        # DEV E2E — visible fixtures
        "HTTP API Stream",
        "S3 Object Stream",
        "Database Query Stream",
        "Remote File Stream",
        "Webhook Receiver Stream",
    }
)

NEGATIVE_VALIDATION_STREAM_TITLES: frozenset[str] = frozenset(
    {
        "Stream empty-response",
        "Stream auth-only",
        "Stream OAuth2 token-exchange-failure",
    }
)

# Deprecated tier sets — retained for compatibility; logic uses per-stream targets.
HIGH_VOLUME_VALIDATION_STREAM_TITLES: frozenset[str] = frozenset(
    {
        "Stream array-response",
        "Stream delivery-only",
        "Database Query PostgreSQL E2E",
        "Database Query MySQL E2E",
        "Database Query MariaDB E2E",
        "S3 Object Polling E2E",
        "Remote File SFTP E2E",
        "Remote File SCP JSON E2E",
        "Stream vendor-malop",
    }
)

HIGH_VOLUME_VISIBLE_E2E_STREAM_TITLES: frozenset[str] = frozenset(
    {
        "HTTP API Stream",
        "Database Query Stream",
        "S3 Object Stream",
    }
)

SINGLE_EVENT_STREAM_TITLES: frozenset[str] = frozenset(
    {
        "Stream single-object",
        "Remote File Stream",
    }
)


def _bare_stream_title(title: str, *, prefix: str) -> str:
    t = str(title or "").strip()
    if t.startswith(prefix):
        return t[len(prefix) :]
    return t


def is_negative_stream_title(title: str, *, prefix: str) -> bool:
    return _bare_stream_title(title, prefix=prefix) in NEGATIVE_VALIDATION_STREAM_TITLES


def is_high_volume_stream_title(title: str, *, prefix: str) -> bool:
    bare = _bare_stream_title(title, prefix=prefix)
    if prefix == _VISIBLE_E2E_PREFIX:
        return bare in HIGH_VOLUME_VISIBLE_E2E_STREAM_TITLES
    return bare in HIGH_VOLUME_VALIDATION_STREAM_TITLES


def _rng_for_bare_title(bare: str) -> random.Random:
    seed = zlib.crc32(bare.encode("utf-8")) & 0xFFFFFFFF
    return random.Random(seed)


def lab_target_eps_for_bare_title(bare: str) -> int:
    """Stable pseudo-random EPS target in [LAB_EPS_MIN, LAB_EPS_MAX] for active lab streams."""

    if bare not in LAB_ACTIVE_STREAM_TITLES:
        return LAB_EPS_MIN
    return _rng_for_bare_title(bare).randint(LAB_EPS_MIN, LAB_EPS_MAX)


def lab_target_eps_for_title(title: str, *, prefix: str) -> int | None:
    if is_negative_stream_title(title, prefix=prefix):
        return None
    bare = _bare_stream_title(title, prefix=prefix)
    if bare not in LAB_ACTIVE_STREAM_TITLES:
        return LAB_EPS_MIN
    return lab_target_eps_for_bare_title(bare)


def lab_http_path_for_bare_title(bare: str) -> str:
    if bare == "Stream single-object":
        return LAB_HTTP_SINGLE_PATH
    if bare == "Stream nested-array":
        return LAB_HTTP_NESTED_PATH
    if bare in {"Stream OAuth2 client-credentials", "Stream OAuth2 refresh-cycle (JWT token URL)"}:
        return LAB_HTTP_OKTA_LOGS_PATH
    if bare in {"Stream vendor-malop", "Stream array-response", "Stream delivery-only", "HTTP API Stream"}:
        return LAB_HTTP_HIGH_PATH
    if bare == "Stream session-events":
        return LAB_HTTP_BASE_PATH
    return LAB_HTTP_BASE_PATH


def lab_effective_cycle_seconds(polling_interval_seconds: int) -> float:
    return float(LAB_EXPECTED_RUN_DURATION_SEC) + max(1.0, float(polling_interval_seconds))


def lab_events_per_poll_for_target(target_eps: int, polling_interval_seconds: int = LAB_POLLING_INTERVAL_MIN) -> int:
    """Batch size so sustained EPS meets target given run duration + polling sleep."""

    target = max(LAB_EPS_MIN, min(LAB_EPS_MAX, int(target_eps)))
    events = int(math.ceil(target * lab_effective_cycle_seconds(polling_interval_seconds)))
    return max(LAB_EPS_MIN, min(LAB_MAX_EVENTS_PER_POLL, events))


def lab_http_events_for_path(path: str) -> int:
    matching = [bare for bare in LAB_ACTIVE_STREAM_TITLES if lab_http_path_for_bare_title(bare) == path]
    if not matching:
        return lab_events_per_poll_for_target(LAB_EPS_MIN, LAB_POLLING_INTERVAL_MIN)
    events = max(lab_http_events_for_bare_title(bare) for bare in matching)
    if path == LAB_HTTP_HIGH_PATH:
        # Under full lab scheduler load an arbitrary 60-second window can contain
        # only 13 completed visible HTTP runs. Twenty-four events keeps that
        # window above 5 EPS while the normal 1.25-second cycle remains <=20 EPS.
        events = max(events, math.ceil(LAB_EPS_MIN * 60 / 13))
    return events


def lab_http_events_for_bare_title(bare: str) -> int:
    target = lab_target_eps_for_bare_title(bare)
    interval = lab_polling_interval_for_bare_title(bare)
    return lab_events_per_poll_for_target(target, interval)


def lab_polling_interval_for_events(*, events_per_poll: int, target_eps: int) -> int:
    """Pick polling interval so sustained EPS stays within [LAB_EPS_MIN, LAB_EPS_MAX]."""

    events = max(1, int(events_per_poll))
    target = max(LAB_EPS_MIN, min(LAB_EPS_MAX, int(target_eps)))
    ideal = max(1, round(events / target))
    min_interval = max(1, (events + LAB_EPS_MAX) // LAB_EPS_MAX)
    max_interval = max(1, events // LAB_EPS_MIN)
    interval = max(min_interval, min(max_interval, ideal))
    return max(LAB_POLLING_INTERVAL_MIN, min(LAB_POLLING_INTERVAL_MAX, interval))


def lab_polling_interval_for_title(title: str, *, prefix: str) -> int:
    if is_negative_stream_title(title, prefix=prefix):
        return LAB_POLLING_INTERVAL_NEGATIVE
    bare = _bare_stream_title(title, prefix=prefix)
    return lab_polling_interval_for_bare_title(bare)


def lab_estimated_http_eps(*, events_per_poll: int, polling_interval_seconds: int) -> float:
    return float(events_per_poll) / lab_effective_cycle_seconds(polling_interval_seconds)


def lab_estimated_eps_for_title(title: str, *, prefix: str) -> float | None:
    if is_negative_stream_title(title, prefix=prefix):
        return None
    bare = _bare_stream_title(title, prefix=prefix)
    if bare == "Webhook Receiver Stream":
        interval = lab_polling_interval_for_bare_title(bare)
        events = lab_sustained_events_per_poll_for_bare_title(bare)
        return events / lab_effective_cycle_seconds(interval)
    if bare in {
        "Database Query PostgreSQL E2E",
        "Database Query MySQL E2E",
        "Database Query MariaDB E2E",
        "Database Query Stream",
    }:
        interval = lab_polling_interval_for_bare_title(bare)
        rows = lab_sustained_events_per_poll_for_bare_title(bare)
        return float(rows) / lab_effective_cycle_seconds(interval)
    if bare in {"S3 Object Polling E2E", "S3 Object Stream"}:
        interval = lab_polling_interval_for_bare_title(bare)
        events = lab_sustained_events_per_poll_for_bare_title(bare)
        return float(events) / lab_effective_cycle_seconds(interval)
    if bare in {"Remote File SFTP E2E", "Remote File SCP JSON E2E", "Remote File Stream"}:
        interval = lab_polling_interval_for_bare_title(bare)
        events = lab_sustained_events_per_poll_for_bare_title(bare)
        return float(events) / lab_effective_cycle_seconds(interval)
    events = lab_http_events_for_bare_title(bare)
    interval = lab_polling_interval_for_bare_title(bare)
    return lab_estimated_http_eps(events_per_poll=events, polling_interval_seconds=interval)


def lab_http_eps_within_target(title: str, *, prefix: str) -> bool:
    eps = lab_estimated_eps_for_title(title, prefix=prefix)
    if eps is None:
        return True
    return LAB_EPS_MIN <= eps <= LAB_EPS_MAX


def lab_http_events_for_title(title: str, *, prefix: str) -> int:
    bare = _bare_stream_title(title, prefix=prefix)
    return lab_http_events_for_bare_title(bare)


def lab_http_endpoint_for_stream(
    stream_title: str,
    *,
    prefix: str,
    current_endpoint: str,
) -> str:
    if is_negative_stream_title(stream_title, prefix=prefix):
        return current_endpoint
    bare = _bare_stream_title(stream_title, prefix=prefix)
    if bare not in LAB_ACTIVE_STREAM_TITLES:
        return current_endpoint
    if not str(current_endpoint or "").strip().startswith("/api/"):
        return current_endpoint
    return lab_http_path_for_bare_title(bare)


def _is_lab_throughput_http_endpoint(endpoint: str) -> bool:
    return str(endpoint or "").strip().startswith("/api/v1/lab-throughput/")


def apply_lab_http_throughput_config(
    config_json: dict[str, Any],
    *,
    stream_title: str,
    prefix: str,
) -> dict[str, Any]:
    """Return ``config_json`` with lab throughput HTTP endpoint when applicable."""

    out = dict(config_json)
    if is_negative_stream_title(stream_title, prefix=prefix):
        return out
    bare = _bare_stream_title(stream_title, prefix=prefix)
    if bare not in LAB_ACTIVE_STREAM_TITLES:
        return out
    endpoint = str(out.get("endpoint") or "").strip()
    if not endpoint:
        return out
    new_endpoint = lab_http_path_for_bare_title(bare)
    out["endpoint"] = new_endpoint
    if _is_lab_throughput_http_endpoint(new_endpoint):
        out["method"] = "GET"
        out.pop("body", None)
        out.pop("params", None)
    return out


def _max_target_eps_for(*titles: str) -> int:
    return max(lab_target_eps_for_bare_title(t) for t in titles)


_DB_STREAM_TITLES: frozenset[str] = frozenset(
    {
        "Database Query PostgreSQL E2E",
        "Database Query MySQL E2E",
        "Database Query MariaDB E2E",
        "Database Query Stream",
    }
)

_S3_STREAM_TITLES: frozenset[str] = frozenset({"S3 Object Polling E2E", "S3 Object Stream"})

_REMOTE_FILE_TITLES: frozenset[str] = frozenset(
    {"Remote File SFTP E2E", "Remote File SCP JSON E2E", "Remote File Stream"}
)


def lab_feed_db_rows_per_tick() -> int:
    # The feeder ticks once per second by default, so generate target EPS here.
    # Poll-cycle batch sizing belongs to the consumer, not to the producer tick.
    return _max_target_eps_for(*_DB_STREAM_TITLES)


def lab_feed_webhook_events_per_tick() -> int:
    # Live webhook ingestion includes synchronous route processing and can stretch
    # to ~4 seconds under validation load. Use the bounded 20-event batch so a
    # slow cycle still clears 5 EPS while the normal 1-second cycle stays at the
    # acceptance ceiling rather than exceeding it.
    return LAB_EPS_MAX


def lab_feed_s3_objects_per_tick() -> int:
    lines_per_object = 4
    slow_live_poll_seconds = 10
    # S3 polling has a materially longer live cycle than in-memory HTTP fixtures.
    # Keep a bounded rolling set large enough to clear the 5 EPS floor even when
    # an observed live poll takes ~10 seconds. Thirteen 4-line objects yield 52
    # events per poll, which also remains below 20 EPS at a 3-second recovery cycle.
    return max(
        math.ceil(LAB_EPS_MIN * slow_live_poll_seconds / lines_per_object),
        math.ceil(_max_target_eps_for(*_S3_STREAM_TITLES) / lines_per_object),
    )


def lab_feed_remote_files_per_tick() -> int:
    lines_per_file = 3
    return max(
        1,
        math.ceil(
            _max_target_eps_for(*(t for t in _REMOTE_FILE_TITLES if t != "Remote File Stream"))
            / lines_per_file
        ),
    )


def lab_sustained_events_per_poll_for_bare_title(bare: str) -> int:
    """Events ingested per stream poll cycle used for interval tuning."""

    target = lab_target_eps_for_bare_title(bare)
    interval = LAB_POLLING_INTERVAL_MIN
    return lab_events_per_poll_for_target(target, interval)


def lab_polling_interval_for_bare_title(bare: str) -> int:
    if bare in NEGATIVE_VALIDATION_STREAM_TITLES:
        return LAB_POLLING_INTERVAL_NEGATIVE
    return LAB_POLLING_INTERVAL_MIN


def lab_webhook_destination_config_patch(config_json: dict[str, Any]) -> dict[str, Any]:
    """Ensure lab webhook destinations use batched POSTs for sustained EPS."""

    out = dict(config_json or {})
    out["payload_mode"] = LAB_WEBHOOK_PAYLOAD_MODE
    out["batch_size"] = LAB_WEBHOOK_BATCH_SIZE
    return out


def lab_feed_tick_rates(*, high_volume: bool = True) -> dict[str, int]:
    """Batch sizes for one feeder tick (1s default)."""

    if not high_volume:
        return {
            "db_rows": LAB_FEED_DB_ROWS_BASE,
            "s3_objects": LAB_FEED_S3_OBJECTS_BASE,
            "remote_files": LAB_FEED_REMOTE_FILES_BASE,
            "webhook_events": LAB_FEED_WEBHOOK_EVENTS_BASE,
            "remote_visible_lines": LAB_FEED_REMOTE_VISIBLE_LINES,
        }
    return {
        "db_rows": lab_feed_db_rows_per_tick(),
        "s3_objects": lab_feed_s3_objects_per_tick(),
        "remote_files": lab_feed_remote_files_per_tick(),
        "webhook_events": lab_feed_webhook_events_per_tick(),
        # The visible remote-file stream uses an exact-filename fast path, so a
        # bounded 50-event file clears 5 EPS even at a 10-second cycle while
        # remaining below 20 EPS at a 3-second recovery cycle.
        "remote_visible_lines": LAB_EPS_MIN * 10,
    }
