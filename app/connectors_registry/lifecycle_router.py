"""HTTP routes for Marketplace package lifecycle (under connectors-registry)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.lifecycle_schemas import (
    MarketplacePackageInstallRead,
    MarketplacePackageListResponse,
)
from app.connectors_registry.lifecycle_service import (
    install_package,
    list_installed_packages,
    rollback_package,
    uninstall_package,
    upgrade_package,
)
from app.database import get_db

router = APIRouter(prefix="/packages", tags=["connectors-registry-packages"])

_UNPROCESSABLE = 422

_ERROR_STATUS: dict[str, int] = {
    "PACKAGE_ALREADY_INSTALLED": status.HTTP_409_CONFLICT,
    "BUILTIN_SHADOW_FORBIDDEN": status.HTTP_409_CONFLICT,
    "PACKAGE_NOT_INSTALLED": status.HTTP_404_NOT_FOUND,
    "PACKAGE_ID_MISMATCH": status.HTTP_400_BAD_REQUEST,
    "SAME_VERSION": status.HTTP_400_BAD_REQUEST,
    "BUILTIN_UNINSTALL_FORBIDDEN": status.HTTP_403_FORBIDDEN,
    "DEPENDENCY_PROTECTED": status.HTTP_409_CONFLICT,
    "DEPENDENCY_MISSING": _UNPROCESSABLE,
    "DEPENDENCY_REQUIRED": _UNPROCESSABLE,
    "DEPENDENCY_VERSION_MISMATCH": _UNPROCESSABLE,
    "ROLLBACK_UNAVAILABLE": status.HTTP_409_CONFLICT,
    "ARCHIVE_MALFORMED": status.HTTP_400_BAD_REQUEST,
    "ARCHIVE_PATH_TRAVERSAL": status.HTTP_400_BAD_REQUEST,
    "ARCHIVE_ABSOLUTE_PATH": status.HTTP_400_BAD_REQUEST,
    "ARCHIVE_LINK_ESCAPE": status.HTTP_400_BAD_REQUEST,
    "ARCHIVE_ROOT_ESCAPE": status.HTTP_400_BAD_REQUEST,
    "ARCHIVE_SPECIAL_FILE": status.HTTP_400_BAD_REQUEST,
    "ARCHIVE_DUPLICATE_TARGET": status.HTTP_400_BAD_REQUEST,
    "MANIFEST_MISSING": status.HTTP_400_BAD_REQUEST,
    "MANIFEST_INVALID": status.HTTP_400_BAD_REQUEST,
    "PACKAGE_ROOT_AMBIGUOUS": status.HTTP_400_BAD_REQUEST,
}


def _http_for_lifecycle(exc: LifecycleError) -> HTTPException:
    code = _ERROR_STATUS.get(exc.error_code, status.HTTP_400_BAD_REQUEST)
    return HTTPException(
        status_code=code,
        detail={
            "error_code": exc.error_code,
            "message": exc.message,
            "details": exc.details,
        },
    )


def _ensure_tar_gz_filename(filename: str | None) -> None:
    name = (filename or "").strip().lower()
    if not name.endswith(".tar.gz") and not name.endswith(".tgz"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "UNSUPPORTED_PACKAGE_FORMAT",
                "message": "only .tar.gz package archives are supported",
            },
        )


@router.get("", response_model=MarketplacePackageListResponse)
@router.get("/", response_model=MarketplacePackageListResponse, include_in_schema=False)
async def get_installed_packages(db: Session = Depends(get_db)) -> MarketplacePackageListResponse:
    """List platform-owned INSTALLED marketplace packages."""

    return list_installed_packages(db)


@router.post(
    "/install",
    response_model=MarketplacePackageInstallRead,
    status_code=status.HTTP_201_CREATED,
)
async def post_install_package(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> MarketplacePackageInstallRead:
    """Acquire a local ``.tar.gz`` archive, validate, and install into the plugins root."""

    _ensure_tar_gz_filename(file.filename)
    try:
        data = await file.read()
        return install_package(db, data)
    except LifecycleError as exc:
        raise _http_for_lifecycle(exc) from exc


@router.post(
    "/{package_id}/upgrade",
    response_model=MarketplacePackageInstallRead,
)
async def post_upgrade_package(
    package_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> MarketplacePackageInstallRead:
    """Upgrade an installed package to a different pack_version."""

    _ensure_tar_gz_filename(file.filename)
    try:
        data = await file.read()
        return upgrade_package(db, package_id, data)
    except LifecycleError as exc:
        raise _http_for_lifecycle(exc) from exc


@router.post(
    "/{package_id}/rollback",
    response_model=MarketplacePackageInstallRead,
)
async def post_rollback_package(
    package_id: str,
    db: Session = Depends(get_db),
) -> MarketplacePackageInstallRead:
    """Roll package files/catalog version back to the previous generation."""

    try:
        return rollback_package(db, package_id)
    except LifecycleError as exc:
        raise _http_for_lifecycle(exc) from exc


@router.delete(
    "/{package_id}",
    response_model=MarketplacePackageInstallRead,
)
async def delete_uninstall_package(
    package_id: str,
    db: Session = Depends(get_db),
) -> MarketplacePackageInstallRead:
    """Uninstall an installed package when no proven configuration dependency exists."""

    try:
        return uninstall_package(db, package_id)
    except LifecycleError as exc:
        raise _http_for_lifecycle(exc) from exc
