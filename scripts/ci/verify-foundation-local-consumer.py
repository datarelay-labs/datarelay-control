#!/usr/bin/env python3
"""Fail-closed verification for the current pinned local Product Foundation consumer."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = ROOT / "frontend" / "foundation.lock.json"
PACKAGE_JSON_PATH = ROOT / "frontend" / "package.json"
PACK_ROOT = ROOT / ".foundation" / "packs"
VENDOR_ROOT = ROOT / "vendor" / "onprem-security"


def fail(reason: str) -> None:
    raise SystemExit(f"FOUNDATION_LOCAL_CONSUMER=FAIL REASON={reason}")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if not LOCK_PATH.is_file() or LOCK_PATH.is_symlink():
        fail("lock-missing-or-linked")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    if lock.get("schema_version") != 1:
        fail("lock-schema")
    version = lock.get("version")
    source_head = lock.get("source_head")
    if not isinstance(version, str) or not version:
        fail("lock-version")
    if not isinstance(source_head, str) or not re.fullmatch(r"[0-9a-f]{40}", source_head):
        fail("lock-source-head")

    package_json = json.loads(PACKAGE_JSON_PATH.read_text(encoding="utf-8"))
    dependencies = package_json.get("dependencies") or {}
    foundation_deps = {
        name: spec for name, spec in dependencies.items()
        if name.startswith("@datarelay-labs/")
    }
    package_rows = lock.get("packages")
    if not isinstance(package_rows, list) or not package_rows:
        fail("lock-packages")
    package_by_name = {row.get("name"): row for row in package_rows if isinstance(row, dict)}
    if set(package_by_name) != set(foundation_deps):
        fail("package-set-mismatch")

    for name in sorted(package_by_name):
        row = package_by_name[name]
        short = name.split("/", 1)[1]
        filename = f"datarelay-labs-{short}-{version}.tgz"
        expected_spec = f"file:../.foundation/packs/{filename}"
        if foundation_deps[name] != expected_spec:
            fail(f"dependency-spec:{name}")
        archive = PACK_ROOT / filename
        if not archive.is_file() or archive.is_symlink():
            fail(f"archive-missing-or-linked:{name}")
        expected_archive_sha = row.get("archive_sha256")
        if not isinstance(expected_archive_sha, str) or sha256(archive) != expected_archive_sha:
            fail(f"archive-sha256:{name}")
        with tarfile.open(archive, "r:gz") as bundle:
            members = bundle.getmembers()
            if any(member.issym() or member.islnk() for member in members):
                fail(f"archive-link-member:{name}")
            try:
                manifest_member = bundle.getmember("package/package.json")
            except KeyError:
                fail(f"archive-package-json:{name}")
            manifest_file = bundle.extractfile(manifest_member)
            if manifest_file is None:
                fail(f"archive-package-json-readable:{name}")
            manifest = json.loads(manifest_file.read().decode("utf-8"))
            if manifest.get("name") != name:
                fail(f"archive-name:{name}")
            if manifest.get("version") != version:
                fail(f"archive-version:{name}")

    candidate_path = VENDOR_ROOT / "candidate.json"
    if not candidate_path.is_file() or candidate_path.is_symlink():
        fail("wheel-candidate")
    candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
    if candidate.get("source_head") != source_head:
        fail("wheel-source-head")
    wheel_name = candidate.get("wheel")
    wheel_sha = candidate.get("wheel_sha256")
    if not isinstance(wheel_name, str) or not isinstance(wheel_sha, str):
        fail("wheel-candidate-fields")
    wheel = VENDOR_ROOT / wheel_name
    if not wheel.is_file() or wheel.is_symlink():
        fail("wheel-missing-or-linked")
    if sha256(wheel) != wheel_sha:
        fail("wheel-sha256")
    sums = (VENDOR_ROOT / "SHA256SUMS").read_text(encoding="ascii").strip()
    if sums != f"{wheel_sha}  {wheel_name}":
        fail("wheel-sha256sums")

    print(
        "FOUNDATION_LOCAL_CONSUMER=PASS "
        f"VERSION={version} SOURCE_HEAD={source_head} PACKAGES={len(package_rows)} "
        f"WHEEL_SHA256={wheel_sha}"
    )
    print("FOUNDATION_SIGNATURE_CLAIM=NONE_PRIVATE_UNPUBLISHED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
