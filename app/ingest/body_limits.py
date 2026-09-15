"""Bounded request-body reads for push ingest endpoints."""

from __future__ import annotations

from fastapi import HTTPException, Request

# Matches WebhookReceiver._max_request_bytes upper clamp.
HARD_MAX_REQUEST_BYTES = 10 * 1024 * 1024


async def read_request_body_capped(request: Request, max_bytes: int) -> bytes:
    """Enforce size before / while reading; never call ``await request.body()`` unbounded.

    Checks ``Content-Length`` when present, then streams with a hard byte cap.
    """

    limit = max(1024, min(int(max_bytes), HARD_MAX_REQUEST_BYTES))
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared = int(content_length)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail={"error_code": "INVALID_CONTENT_LENGTH", "message": "Invalid Content-Length header"},
            ) from exc
        if declared < 0:
            raise HTTPException(
                status_code=400,
                detail={"error_code": "INVALID_CONTENT_LENGTH", "message": "Invalid Content-Length header"},
            )
        if declared > limit:
            raise HTTPException(
                status_code=413,
                detail={
                    "error_code": "WEBHOOK_PAYLOAD_TOO_LARGE",
                    "message": f"Webhook payload exceeds {limit} bytes",
                },
            )

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        if not chunk:
            continue
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                status_code=413,
                detail={
                    "error_code": "WEBHOOK_PAYLOAD_TOO_LARGE",
                    "message": f"Webhook payload exceeds {limit} bytes",
                },
            )
        chunks.append(chunk)
    return b"".join(chunks)
