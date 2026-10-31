"""Route-level retry/backoff policy resolved from the Route's saved configuration (F-168).

The Route editor stores ``max_retry``, ``retry_backoff`` (Exponential|Linear),
``initial_backoff_sec``, ``max_backoff_sec`` and ``max_delivery_time_sec`` inside
``Route.rate_limit_json``. The runtime used to ignore them and retry a fixed ``retry_count``
(default 2) with a hard-coded exponential delay, so the operator-configured policy never ran.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.runtime.errors import is_retryable_http_status

# Legacy defaults, used only when the Route has no saved retry configuration.
DEFAULT_MAX_RETRIES = 2
DEFAULT_INITIAL_BACKOFF_SEC = 1.0
DEFAULT_MAX_BACKOFF_SEC = 60.0
_MAX_RETRIES_CEILING = 100


@dataclass(frozen=True, slots=True)
class RouteRetryPolicy:
    max_retries: int
    backoff_mode: str  # "exponential" | "linear"
    initial_backoff_sec: float
    max_backoff_sec: float
    max_delivery_time_sec: float  # 0 means unlimited

    def delay_before_retry(self, retry_index: int) -> float:
        """Seconds to wait before retry number ``retry_index + 1`` (0-based index)."""

        idx = max(0, int(retry_index))
        if self.backoff_mode == "linear":
            delay = self.initial_backoff_sec * (idx + 1)
        else:
            delay = self.initial_backoff_sec * (2**idx)
        if self.max_backoff_sec > 0:
            delay = min(delay, self.max_backoff_sec)
        return max(0.0, float(delay))


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out not in (float("inf"), float("-inf")) else None


def _field(route: Any, key: str, default: Any = None) -> Any:
    if isinstance(route, dict):
        return route.get(key, default)
    return getattr(route, key, default)


def resolve_route_retry_policy(route: Any) -> RouteRetryPolicy:
    """Resolve the retry policy of a Route (dict or ORM row) from its saved configuration."""

    rate = _field(route, "rate_limit_json")
    rate = rate if isinstance(rate, dict) else {}

    max_retry = _num(rate.get("max_retry"))
    if max_retry is None:
        max_retry = _num(_field(route, "retry_count"))
    if max_retry is None:
        max_retry = float(DEFAULT_MAX_RETRIES)
    max_retries = max(0, min(int(max_retry), _MAX_RETRIES_CEILING))

    initial = _num(rate.get("initial_backoff_sec"))
    if initial is None:
        initial = _num(_field(route, "backoff_seconds"))
    if initial is None or initial < 0:
        initial = DEFAULT_INITIAL_BACKOFF_SEC

    max_backoff = _num(rate.get("max_backoff_sec"))
    if max_backoff is None or max_backoff < 0:
        max_backoff = DEFAULT_MAX_BACKOFF_SEC

    max_delivery = _num(rate.get("max_delivery_time_sec"))
    if max_delivery is None or max_delivery < 0:
        max_delivery = 0.0

    mode = str(rate.get("retry_backoff") or "").strip().lower()
    return RouteRetryPolicy(
        max_retries=max_retries,
        backoff_mode="linear" if mode == "linear" else "exponential",
        initial_backoff_sec=float(initial),
        max_backoff_sec=float(max_backoff),
        max_delivery_time_sec=float(max_delivery),
    )


def http_status_of(error: BaseException | None) -> int | None:
    status = getattr(error, "http_status", None)
    if isinstance(status, bool) or not isinstance(status, int):
        return None
    return status


def is_retryable_delivery_error(error: BaseException | None) -> bool:
    """False for client errors a retry cannot fix (HTTP 4xx except 408/425/429)."""

    return is_retryable_http_status(http_status_of(error))
