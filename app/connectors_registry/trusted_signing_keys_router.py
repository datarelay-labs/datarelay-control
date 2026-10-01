"""HTTP routes for Marketplace trusted signing public keys."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.role_guard import ROLE_ADMINISTRATOR, require_roles
from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.trusted_signing_keys_schemas import (
    TrustedSigningKeyCreate,
    TrustedSigningKeyListResponse,
    TrustedSigningKeyRead,
    TrustedSigningKeyUpdate,
)
from app.connectors_registry.trusted_signing_keys_service import (
    create_trusted_signing_key,
    delete_trusted_signing_key,
    get_trusted_signing_key,
    list_trusted_signing_keys,
    update_trusted_signing_key,
)
from app.database import get_db

router = APIRouter(
    prefix="/trusted-signing-keys",
    tags=["connectors-registry-trusted-keys"],
)

_ERROR_STATUS: dict[str, int] = {
    "TRUSTED_KEY_NOT_FOUND": status.HTTP_404_NOT_FOUND,
    "TRUSTED_KEY_EXISTS": status.HTTP_409_CONFLICT,
    "TRUSTED_KEY_INVALID": status.HTTP_400_BAD_REQUEST,
    "TRUSTED_KEY_PRIVATE_FORBIDDEN": status.HTTP_400_BAD_REQUEST,
}


def _http_for(exc: LifecycleError) -> HTTPException:
    code = _ERROR_STATUS.get(exc.error_code, status.HTTP_400_BAD_REQUEST)
    return HTTPException(
        status_code=code,
        detail={
            "error_code": exc.error_code,
            "message": exc.message,
            "details": exc.details,
        },
    )


@router.get("", response_model=TrustedSigningKeyListResponse)
@router.get("/", response_model=TrustedSigningKeyListResponse, include_in_schema=False)
async def get_trusted_keys(db: Session = Depends(get_db)) -> TrustedSigningKeyListResponse:
    """List platform-owned trusted signing public keys (read)."""

    return list_trusted_signing_keys(db)


@router.get("/{key_id}", response_model=TrustedSigningKeyRead)
async def get_trusted_key(key_id: str, db: Session = Depends(get_db)) -> TrustedSigningKeyRead:
    try:
        return get_trusted_signing_key(db, key_id)
    except LifecycleError as exc:
        raise _http_for(exc) from exc


@router.post(
    "",
    response_model=TrustedSigningKeyRead,
    status_code=status.HTTP_201_CREATED,
)
@router.post(
    "/",
    response_model=TrustedSigningKeyRead,
    status_code=status.HTTP_201_CREATED,
    include_in_schema=False,
)
async def post_trusted_key(
    payload: TrustedSigningKeyCreate,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_roles(ROLE_ADMINISTRATOR)),
) -> TrustedSigningKeyRead:
    """Create a trusted Ed25519 public key (Administrator only)."""

    try:
        return create_trusted_signing_key(db, payload)
    except LifecycleError as exc:
        raise _http_for(exc) from exc


@router.patch("/{key_id}", response_model=TrustedSigningKeyRead)
async def patch_trusted_key(
    key_id: str,
    payload: TrustedSigningKeyUpdate,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_roles(ROLE_ADMINISTRATOR)),
) -> TrustedSigningKeyRead:
    """Update / enable-disable a trusted signing key (Administrator only)."""

    try:
        return update_trusted_signing_key(db, key_id, payload)
    except LifecycleError as exc:
        raise _http_for(exc) from exc


@router.delete("/{key_id}", response_model=TrustedSigningKeyRead)
async def delete_trusted_key(
    key_id: str,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_roles(ROLE_ADMINISTRATOR)),
) -> TrustedSigningKeyRead:
    """Delete a trusted signing key (Administrator only)."""

    try:
        return delete_trusted_signing_key(db, key_id)
    except LifecycleError as exc:
        raise _http_for(exc) from exc
