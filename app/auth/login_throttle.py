"""Login brute-force / rate protection (per-account + per-source IP).

Process-local sliding windows are intentionally soft: they slow credential stuffing
without creating a permanent account lockout DoS. Multi-worker deployments each
enforce their own window; that is still better than an unprotected login endpoint.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from fastapi import HTTPException, Request, status


@dataclass(frozen=True)
class LoginThrottleConfig:
    max_failures_per_username: int = 8
    max_failures_per_ip: int = 40
    window_seconds: float = 15 * 60
    lockout_seconds: float = 60


_DEFAULT = LoginThrottleConfig()
_guard = threading.Lock()
_by_username: dict[str, deque[float]] = defaultdict(deque)
_by_ip: dict[str, deque[float]] = defaultdict(deque)


def _prune(q: deque[float], *, now: float, window: float) -> None:
    cutoff = now - window
    while q and q[0] < cutoff:
        q.popleft()


def reset_login_throttle_for_tests() -> None:
    with _guard:
        _by_username.clear()
        _by_ip.clear()


def client_ip_from_request(request: Request | None) -> str:
    if request is None:
        return "unknown"
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded[:128]
    if request.client and request.client.host:
        return str(request.client.host)[:128]
    return "unknown"


def check_login_allowed(
    *,
    username: str,
    ip: str,
    config: LoginThrottleConfig | None = None,
) -> None:
    """Raise HTTP 429 when recent failures exceed soft limits."""

    cfg = config or _DEFAULT
    now = time.monotonic()
    user_key = (username or "").strip().casefold() or "(empty)"
    ip_key = (ip or "").strip() or "unknown"
    with _guard:
        uq = _by_username[user_key]
        iq = _by_ip[ip_key]
        _prune(uq, now=now, window=cfg.window_seconds)
        _prune(iq, now=now, window=cfg.window_seconds)
        if len(uq) >= cfg.max_failures_per_username or len(iq) >= cfg.max_failures_per_ip:
            retry_after = max(1, int(cfg.lockout_seconds))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "error_code": "LOGIN_RATE_LIMITED",
                    "message": "Too many failed login attempts. Try again shortly.",
                },
                headers={"Retry-After": str(retry_after)},
            )


def record_login_failure(
    *,
    username: str,
    ip: str,
    config: LoginThrottleConfig | None = None,
) -> None:
    cfg = config or _DEFAULT
    now = time.monotonic()
    user_key = (username or "").strip().casefold() or "(empty)"
    ip_key = (ip or "").strip() or "unknown"
    with _guard:
        uq = _by_username[user_key]
        iq = _by_ip[ip_key]
        _prune(uq, now=now, window=cfg.window_seconds)
        _prune(iq, now=now, window=cfg.window_seconds)
        uq.append(now)
        iq.append(now)


def record_login_success(*, username: str, ip: str) -> None:
    """Clear the per-username window after a successful login (IP window kept)."""

    user_key = (username or "").strip().casefold() or "(empty)"
    with _guard:
        _by_username.pop(user_key, None)


__all__ = [
    "LoginThrottleConfig",
    "check_login_allowed",
    "client_ip_from_request",
    "record_login_failure",
    "record_login_success",
    "reset_login_throttle_for_tests",
]
