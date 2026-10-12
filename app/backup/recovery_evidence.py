"""Read-only PF-12B adapter for already-produced Control PostgreSQL archives.

Read archive bytes and its nearby SHA256 sidecar only when explicitly invoked
on a named file. Never query a DB, decrypt, restore, schedule or claim evidence
of backup provenance or actual isolated recovery.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
import re
import stat
from typing import Any

from datarelay_onprem_security import (
    BackupEvidence, BackupKind, BackupPolicy, BackupState,
    RestoreEvidence, assess_backup, preview_restore,
)

_SHA256_SIDECAR = re.compile(rb"([a-f0-9]{64})  ([^/\\\r\n]+)\n\Z")
_MAX_ARCHIVE_BYTES = 2**60


def _read_archive_receipt(path: Path) -> tuple[str, int, int]:
    """Hash one stable, regular archive and exact accompanying sidecar.

    O_NOFOLLOW and before/after fstat prevent common symlink and concurrent
    archive-write races. A self-authored checksum is *not* a publisher signature.
    """
    archive = Path(path)
    if not (archive.name.endswith(".dump") or archive.name.endswith(".dump.gz")):
        raise ValueError("Unsupported backup archive format")
    sidecar_path = Path(str(archive) + ".sha256")
    # O_NOFOLLOW protects only the final path component. Reject linked
    # ancestors as well, including paths supplied through a linked directory.
    # A trusted real restore still requires independent operator authorization.
    for candidate in (archive, sidecar_path):
        absolute = candidate.absolute()
        if any(part.is_symlink() for part in (absolute, *absolute.parents)):
            raise ValueError("Symlink backup evidence path is untrusted")

    archive_fd = None
    sidecar_fd = None
    try:
        archive_fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        sidecar_fd = os.open(
            str(archive) + ".sha256",
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
        with os.fdopen(archive_fd, "rb", closefd=True) as src, os.fdopen(
            sidecar_fd, "rb", closefd=True,
        ) as sig:
            archive_fd = sidecar_fd = None
            before = os.fstat(src.fileno())
            side = os.fstat(sig.fileno())
            if not stat.S_ISREG(before.st_mode) or not stat.S_ISREG(side.st_mode):
                raise ValueError("Archive evidence is not a regular file")
            if (stat.S_IMODE(before.st_mode) & 0o077 or
                    stat.S_IMODE(side.st_mode) & 0o077):
                # The product backup script creates 0600 outputs. Treat
                # potentially shared/unprotected copies as unqualified.
                raise ValueError("Archive evidence permissions are not private")
            if not 0 < before.st_size <= _MAX_ARCHIVE_BYTES or side.st_size > 512:
                raise ValueError("Archive or sidecar size is invalid")
            sidecar = sig.read(513)
            match = _SHA256_SIDECAR.fullmatch(sidecar)
            if match is None or match.group(2) != os.fsencode(archive.name):
                raise ValueError("Sidecar does not identify the named archive")

            digest = hashlib.sha256()
            while chunk := src.read(1024 * 1024):
                digest.update(chunk)
            after = os.fstat(src.fileno())
            if (
                before.st_dev != after.st_dev or before.st_ino != after.st_ino or
                before.st_size != after.st_size or
                before.st_mtime_ns != after.st_mtime_ns or
                before.st_ctime_ns != after.st_ctime_ns
            ):
                raise ValueError("Archive changed during integrity verification")
            hashed = digest.hexdigest()
            if not hmac.compare_digest(hashed.encode("ascii"), match.group(1)):
                raise ValueError("Backup archive bytes do not match checksum")
            return hashed, before.st_size, int(before.st_mtime)
    except OSError as exc:
        raise ValueError("Backup evidence file cannot be inspected safely") from exc
    finally:
        if archive_fd is not None:
            os.close(archive_fd)
        if sidecar_fd is not None:
            os.close(sidecar_fd)


def inspect_backup_archive(archive_path: Path, *, now: int) -> dict[str, Any]:
    """Secret-free, unqualified DR metadata for an explicitly named archive.

    No caller-provided metadata may assert encryption, vendor provenance,
    restore success, role/MFA authority, installed schema or backup scheduling.
    Even a correct digest only proves these *bytes* match this untrusted
    colocated checksum file.
    """
    digest, size, created_at = _read_archive_receipt(Path(archive_path))
    receipt = BackupEvidence(
        product_ref="datarelay.control",
        backup_ref="backup." + digest[:24],
        revision_ref="unverified",
        kind=BackupKind.DISASTER_RECOVERY,
        # Matching an untrusted sidecar cannot prove pg_dump exited cleanly.
        state=BackupState.INCOMPLETE,
        created_at=created_at,
        artifact_bytes=size,
        archive_sha256=digest,
        encrypted_at_rest=False,
        restore_drill_verified_at=None,
    )
    assessment = assess_backup(receipt, now=now, policy=BackupPolicy())
    restore = preview_restore(
        receipt,
        RestoreEvidence(
            expected_product_ref="datarelay.control",
            expected_backup_revision="unverified",
            artifact_integrity_verified=True,
            # Current script cannot establish trustworthy encryption,
            # restore drilling, actor identity, rollback or release gates.
            current_product_supports_restore=False,
        ),
    )
    return {
        "product_ref": receipt.product_ref,
        "backup_ref": receipt.backup_ref,
        "artifact_bytes": receipt.artifact_bytes,
        "archive_sha256": receipt.archive_sha256,
        "created_at": receipt.created_at,
        "created_at_authoritative": False,
        "configuration_export": False,
        "byte_integrity_verified": True,
        "digest_publisher_authenticated": False,
        "encrypted_at_rest": False,
        "restore_drill_verified": False,
        "schema_compatibility_verified": False,
        "backup_healthy": assessment.healthy,
        "backup_problems": [x.value for x in assessment.problems],
        "next_scheduled_at_advisory": assessment.next_scheduled_at,
        "retention_versions_advisory": assessment.keep_last,
        "restore_blockers": [x.value for x in restore.blockers],
        "may_submit_to_restore_authority": False,
        "actual_restore_performed": False,
    }
