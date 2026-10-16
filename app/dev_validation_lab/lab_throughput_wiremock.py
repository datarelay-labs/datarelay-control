"""WireMock admin helpers for lab-only throughput stubs (pytest stubs stay unchanged)."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.dev_validation_lab.lab_throughput_config import (
    LAB_HTTP_BASE_PATH,
    LAB_HTTP_HIGH_PATH,
    LAB_HTTP_NESTED_PATH,
    LAB_HTTP_OKTA_LOGS_PATH,
    LAB_HTTP_SINGLE_PATH,
    lab_http_events_for_path,
)

logger = logging.getLogger(__name__)

# Platform compose WireMock (default bridge). Used when the dev-validation fixture
# WireMock container is unreachable but the platform stack WireMock is healthy.
_PLATFORM_WIREMOCK_FALLBACK = "http://gdc-platform-wiremock-test:8080"

_LAB_MAPPING_IDS: tuple[str, ...] = (
    "b2000001-0001-4000-8000-000000000001",
    "b2000001-0001-4000-8000-000000000002",
    "b2000001-0001-4000-8000-000000000003",
    "b2000001-0001-4000-8000-000000000004",
    "b2000001-0001-4000-8000-000000000005",
    "b2000001-0001-4000-8000-000000000006",
)


def _default_event(i: int) -> dict[str, str]:
    return {
        "id": "{{randomValue type='UUID'}}",
        "timestamp": "{{now format='yyyy-MM-dd'}}T{{now format='HH:mm:ss'}}Z",
        "message": f"lab throughput event {i}",
        "severity": "LOW",
    }


def _array_mapping(*, mapping_id: str, url_path: str, count: int) -> dict[str, Any]:
    return {
        "id": mapping_id,
        "priority": 1,
        "request": {"method": "GET", "urlPath": url_path},
        "response": {
            "status": 200,
            "headers": {"Content-Type": "application/json"},
            "transformers": ["response-template"],
            "jsonBody": {"data": [_default_event(i) for i in range(1, count + 1)]},
        },
    }


def _single_object_mapping(*, mapping_id: str, url_path: str, count: int) -> dict[str, Any]:
    return {
        "id": mapping_id,
        "priority": 1,
        "request": {"method": "GET", "urlPath": url_path},
        "response": {
            "status": 200,
            "headers": {"Content-Type": "application/json"},
            "transformers": ["response-template"],
            "jsonBody": {"data": [_default_event(i) for i in range(1, count + 1)]},
        },
    }


def _nested_array_mapping(*, mapping_id: str, url_path: str, count: int) -> dict[str, Any]:
    return {
        "id": mapping_id,
        "priority": 1,
        "request": {"method": "GET", "urlPath": url_path},
        "response": {
            "status": 200,
            "headers": {"Content-Type": "application/json"},
            "transformers": ["response-template"],
            "jsonBody": {
                "outer": {
                    "inner": {
                        "records": [_default_event(i) for i in range(1, count + 1)],
                    }
                }
            },
        },
    }


def _okta_logs_mapping(*, mapping_id: str, url_path: str, count: int) -> dict[str, Any]:
    rows = [
        {
            "uuid": "{{randomValue type='UUID'}}",
            "published": "{{now format='yyyy-MM-dd'}}T{{now format='HH:mm:ss.SSS'}}Z",
            "eventType": "user.session.start",
            "severity": "INFO",
            "actor": {"alternateId": "lab@example.com"},
            "outcome": {"result": "SUCCESS"},
        }
        for _ in range(count)
    ]
    return {
        "id": mapping_id,
        "priority": 1,
        "request": {
            "method": "GET",
            "urlPath": url_path,
            "headers": {"Authorization": {"matches": "Bearer .+"}},
        },
        "response": {
            "status": 200,
            "headers": {"Content-Type": "application/json"},
            "transformers": ["response-template"],
            "jsonBody": rows,
        },
    }


def _visible_e2e_receiver_mapping(*, mapping_id: str) -> dict[str, Any]:
    return {
        "id": mapping_id,
        "priority": 1,
        "request": {"method": "POST", "urlPath": "/dev-visible-e2e/webhook"},
        "response": {
            "status": 200,
            "headers": {"Content-Type": "application/json"},
            "jsonBody": {"ok": True, "receiver": "dev-visible-e2e-wiremock"},
        },
    }


def resolve_lab_wiremock_base_url(*, configured: str) -> str:
    """Return the first healthy WireMock admin base URL (configured, then platform fallback)."""

    candidates: list[str] = []
    primary = str(configured or "").strip().rstrip("/")
    if primary:
        candidates.append(primary)
    if _PLATFORM_WIREMOCK_FALLBACK not in candidates:
        candidates.append(_PLATFORM_WIREMOCK_FALLBACK)
    for base in candidates:
        try:
            with httpx.Client(timeout=3.0) as client:
                response = client.get(f"{base}/__admin/health")
                if response.status_code == 200:
                    return base
        except Exception:
            continue
    return primary or _PLATFORM_WIREMOCK_FALLBACK


def lab_throughput_wiremock_mappings() -> list[dict[str, Any]]:
    return [
        _array_mapping(
            mapping_id=_LAB_MAPPING_IDS[0],
            url_path=LAB_HTTP_BASE_PATH,
            count=lab_http_events_for_path(LAB_HTTP_BASE_PATH),
        ),
        _array_mapping(
            mapping_id=_LAB_MAPPING_IDS[1],
            url_path=LAB_HTTP_HIGH_PATH,
            count=lab_http_events_for_path(LAB_HTTP_HIGH_PATH),
        ),
        _single_object_mapping(
            mapping_id=_LAB_MAPPING_IDS[2],
            url_path=LAB_HTTP_SINGLE_PATH,
            count=lab_http_events_for_path(LAB_HTTP_SINGLE_PATH),
        ),
        _nested_array_mapping(
            mapping_id=_LAB_MAPPING_IDS[3],
            url_path=LAB_HTTP_NESTED_PATH,
            count=lab_http_events_for_path(LAB_HTTP_NESTED_PATH),
        ),
        _okta_logs_mapping(
            mapping_id=_LAB_MAPPING_IDS[4],
            url_path=LAB_HTTP_OKTA_LOGS_PATH,
            count=lab_http_events_for_path(LAB_HTTP_OKTA_LOGS_PATH),
        ),
        _visible_e2e_receiver_mapping(mapping_id=_LAB_MAPPING_IDS[5]),
    ]


def sync_lab_throughput_wiremock_mappings(*, base_url: str) -> bool:
    """Upsert lab throughput stubs via WireMock admin. Fail-open."""

    base = resolve_lab_wiremock_base_url(configured=base_url).rstrip("/")
    ok = True
    try:
        with httpx.Client(timeout=20.0) as client:
            for doc in lab_throughput_wiremock_mappings():
                mid = str(doc.get("id") or "").strip()
                if not mid:
                    continue
                client.delete(f"{base}/__admin/mappings/{mid}")
                r = client.post(f"{base}/__admin/mappings", json=doc)
                if r.status_code not in (200, 201):
                    ok = False
                    logger.warning(
                        "%s",
                        {
                            "stage": "lab_throughput_wiremock_mapping_failed",
                            "mapping_id": mid,
                            "status_code": r.status_code,
                            "body": (r.text or "")[:300],
                        },
                    )
    except Exception as exc:  # pragma: no cover - network fail-open
        logger.warning(
            "%s",
            {
                "stage": "lab_throughput_wiremock_sync_failed",
                "error_type": type(exc).__name__,
                "message": str(exc),
            },
        )
        return False
    logger.info("%s", {"stage": "lab_throughput_wiremock_sync_complete", "success": ok, "mapping_ids": list(_LAB_MAPPING_IDS)})
    return ok


def _journal_disabled_response(*, status_code: int, body: str) -> bool:
    """True when WireMock reports request journal is disabled (platform lab compose)."""

    text = (body or "").lower()
    return status_code in (400, 403, 500) and (
        "requestjournaldisabledexception" in text
        or ("request journal" in text and "disabled" in text)
    )


def wiremock_journal_entry_count(*, base_url: str | None = None) -> tuple[int | None, str]:
    """Return (journal_entry_count, detail). Fail-open with (None, error)."""

    from app.config import settings

    configured = base_url if base_url is not None else str(getattr(settings, "DEV_VALIDATION_WIREMOCK_BASE_URL", "") or "")
    base = resolve_lab_wiremock_base_url(configured=configured).rstrip("/")
    try:
        with httpx.Client(timeout=5.0) as client:
            response = client.get(f"{base}/__admin/requests")
            if response.status_code != 200:
                if _journal_disabled_response(status_code=response.status_code, body=response.text or ""):
                    return 0, f"journal_disabled base={base}"
                return None, f"HTTP {response.status_code}"
            payload = response.json()
            if isinstance(payload, dict) and payload.get("requestJournalDisabled") is True:
                return 0, f"journal_disabled base={base}"
            requests = payload.get("requests") if isinstance(payload, dict) else None
            if not isinstance(requests, list):
                return None, "unexpected_journal_payload"
            return len(requests), f"ok base={base}"
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def reset_wiremock_request_journal(*, base_url: str | None = None) -> bool:
    """DELETE WireMock request journal. Lab-mode callers only; fail-open False."""

    from app.config import settings
    from app.dev_validation_lab.seeder import lab_effective

    if not lab_effective():
        logger.warning("%s", {"stage": "wiremock_journal_reset_skipped", "reason": "lab_not_effective"})
        return False

    configured = base_url if base_url is not None else str(getattr(settings, "DEV_VALIDATION_WIREMOCK_BASE_URL", "") or "")
    base = resolve_lab_wiremock_base_url(configured=configured).rstrip("/")
    try:
        with httpx.Client(timeout=5.0) as client:
            probe = client.get(f"{base}/__admin/requests")
            if _journal_disabled_response(status_code=probe.status_code, body=probe.text or ""):
                logger.info(
                    "%s",
                    {
                        "stage": "wiremock_journal_reset",
                        "ok": True,
                        "status_code": probe.status_code,
                        "base": base,
                        "reason": "journal_disabled",
                    },
                )
                return True
            if probe.status_code == 200:
                payload = probe.json()
                if isinstance(payload, dict) and payload.get("requestJournalDisabled") is True:
                    logger.info(
                        "%s",
                        {
                            "stage": "wiremock_journal_reset",
                            "ok": True,
                            "status_code": 200,
                            "base": base,
                            "reason": "journal_disabled",
                        },
                    )
                    return True
            response = client.delete(f"{base}/__admin/requests")
            ok = response.status_code in (200, 204)
            logger.info(
                "%s",
                {
                    "stage": "wiremock_journal_reset",
                    "ok": ok,
                    "status_code": response.status_code,
                    "base": base,
                },
            )
            return ok
    except Exception as exc:
        logger.warning(
            "%s",
            {
                "stage": "wiremock_journal_reset_failed",
                "error_type": type(exc).__name__,
                "message": str(exc)[:300],
            },
        )
        return False
