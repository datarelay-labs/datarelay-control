"""Read-only PF-9 management ingress policy preview.

Product Foundation owns the CIDR and source matching logic. Control cannot
apply a Web+API ingress ACL until its nginx/host adapter and emergency rollback
are independently installed and qualified. Preview NEVER mutates host state.
"""
from __future__ import annotations

from ipaddress import ip_address

from datarelay_onprem_security import (
    AllowEntry, ManagementPolicy, SurfacePolicy, preview_change,
)
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.login_throttle import client_ip_from_request
from app.auth.role_guard import ROLE_ADMINISTRATOR, resolve_auth_context
from app.database import get_db
from app.platform_admin.models import PlatformUser


class AllowSourceDraft(BaseModel):
    cidr: str = Field(min_length=1, max_length=96)
    name: str = Field(default="", max_length=64)
    expires_at: int | None = Field(default=None, gt=0)


class SurfaceDraft(BaseModel):
    enabled: bool = False
    sources: list[AllowSourceDraft] = Field(default_factory=list, max_length=128)
    revision: str = Field(default="", max_length=128)


class ManagementPreviewRequest(BaseModel):
    web: SurfaceDraft = Field(default_factory=SurfaceDraft)
    ssh: SurfaceDraft = Field(default_factory=SurfaceDraft)
    rollback_seconds: int = Field(default=180, ge=60, le=3600)


class ManagementPreviewResponse(BaseModel):
    mode: str = "PREVIEW_ONLY"
    apply_available: bool = False
    ssh_enforcement_available: bool = False
    web_enforcement_available: bool = False
    observed_api_source: str | None
    web_reason: str
    web_source_matches: bool
    ssh_reason: str
    blockers: list[str]
    candidate_web_enabled: bool
    candidate_ssh_enabled: bool
    rollback_seconds: int


router = APIRouter()


def _policy(draft: SurfaceDraft) -> SurfacePolicy:
    return SurfacePolicy(
        enabled=draft.enabled,
        sources=tuple(
            AllowEntry(cidr=e.cidr, name=e.name, expires_at=e.expires_at)
            for e in draft.sources
        ),
        revision=draft.revision,
    )


def _observed_source(request: Request) -> str | None:
    # request.client.host is the ASGI peer after any *explicitly configured*
    # uvicorn trusted-proxy handling. Do not re-parse XFF or Forwarded from
    # attacker-controlled request headers. In proxy deployments, this is only
    # an advisory API observation; not proof of public nginx client identity.
    raw = client_ip_from_request(request)
    try:
        return str(ip_address(raw))
    except ValueError:
        return None


@router.post("/management-access/preview", response_model=ManagementPreviewResponse)
def preview_management_access(
    payload: ManagementPreviewRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> ManagementPreviewResponse:
    """Administrator-only advisory, NOT an apply/reconfigure endpoint."""
    ctx = resolve_auth_context(request)
    if ctx.source != "jwt" or ctx.role != ROLE_ADMINISTRATOR or ctx.user_id is None:
        raise HTTPException(403, detail={
            "error_code": "ACL_PREVIEW_FORBIDDEN",
            "message": "An authenticated Administrator session is required.",
        })
    account = db.query(PlatformUser).filter(
        PlatformUser.id == int(ctx.user_id),
    ).one_or_none()
    if (
        account is None or account.status != "ACTIVE"
        or account.role != ROLE_ADMINISTRATOR
        or ctx.token_version is None
        or int(account.token_version or 1) != int(ctx.token_version)
    ):
        raise HTTPException(401, detail={
            "error_code": "AUTH_TOKEN_REVOKED",
            "message": "Sign in again.",
        })
    try:
        candidate = ManagementPolicy(web=_policy(payload.web), ssh=_policy(payload.ssh))
    except ValueError as exc:
        raise HTTPException(422, detail={
            "error_code": "ACL_PREVIEW_INVALID_POLICY",
            "message": str(exc),
        }) from exc

    # No authoritative SSH peer/session, host firewall adapter, nginx access
    # read-back, or independent emergency console was verified. This cannot
    # return an apply-safe answer even when a CIDR matches the API peer.
    source = _observed_source(request)
    advisory = preview_change(
        candidate,
        current_web_source=source,
        current_ssh_source=None,
        emergency_console_confirmed=False,
        ssh_enforcement_supported=False,
        rollback_seconds=payload.rollback_seconds,
    )
    blockers = list(advisory.blockers)
    blockers.extend((
        "WEB_PROXY_AND_API_ATOMIC_ENFORCEMENT_UNAVAILABLE",
        "HOST_SSH_APPLY_AND_ROLLBACK_UNAVAILABLE",
        "OBSERVED_API_SOURCE_IS_NOT_VERIFIED_PUBLIC_WEB_INGRESS",
    ))
    return ManagementPreviewResponse(
        observed_api_source=source,
        web_reason=advisory.web_decision.reason.value,
        web_source_matches=advisory.web_decision.allowed,
        ssh_reason=advisory.ssh_decision.reason.value,
        blockers=blockers,
        candidate_web_enabled=candidate.web.enabled,
        candidate_ssh_enabled=candidate.ssh.enabled,
        rollback_seconds=advisory.rollback_seconds,
    )
