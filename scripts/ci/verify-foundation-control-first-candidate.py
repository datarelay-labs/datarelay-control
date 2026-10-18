#!/usr/bin/env python3
"""Verify a local Control-first Foundation *source-only* trial, never release acceptance.

The existing RC50 verifier and its pinned Python wheel remain authoritative.
This additional check covers the two exact upstream unpublished npm artifacts,
without copying proprietary package contents to a public Git repository.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

UPSTREAM_NAMES = {
    "@datarelay-labs/control-clone": "datarelay-labs-control-clone-0.1.0-dev.tgz",
    "@datarelay-labs/foundation": "datarelay-labs-foundation-0.1.0-dev-canonical.tgz",
}


def fail(code: str) -> None:
    raise ValueError(code)


def read_json(path: Path) -> dict:
    if not path.is_file() or path.is_symlink():
        fail(f"missing-or-linked:{path.name}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"invalid-json:{path.name}")
    return value


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as src:
        for chunk in iter(lambda: src.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_tarball(archive: Path, name: str, version: str) -> None:
    if not archive.is_file() or archive.is_symlink() or archive.stat().st_size > 20_000_000:
        fail(f"archive-missing-linked-or-too-large:{name}")
    try:
        with tarfile.open(archive, "r:gz") as handle:
            seen: set[str] = set()
            for member in handle.getmembers():
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or path.parts[0] != "package":
                    fail(f"unsafe-member-path:{name}")
                if member.name in seen or not (member.isfile() or member.isdir()):
                    fail(f"duplicate-or-unsafe-member:{name}")
                seen.add(member.name)
            for required in ("package/package.json",):
                if required not in seen:
                    fail(f"missing-member:{name}:{required}")
            file = handle.extractfile("package/package.json")
            if file is None:
                fail(f"unreadable-manifest:{name}")
            manifest = json.load(file)
            if manifest.get("name") != name or manifest.get("version") != version:
                fail(f"package-identity:{name}")
            if name == "@datarelay-labs/control-clone":
                required = {"package/dist/index.js", "package/dist/index.d.ts",
                            "package/dist/styles.css", "package/control-source-manifest.json"}
                if not required.issubset(seen):
                    fail(f"control-clone-dist-incomplete:{name}")
            elif name == "@datarelay-labs/foundation":
                if manifest.get("dependencies") != {"@datarelay-labs/control-clone": version}:
                    fail("facade-dependency")
                exports = manifest.get("exports", {})
                if not isinstance(exports.get("."), dict):
                    fail("facade-exports")
                file = handle.extractfile("package/index.js")
                if file is None or file.read() != b'export * from "@datarelay-labs/control-clone";\n':
                    fail("facade-entrypoint")
    except (tarfile.TarError, OSError, json.JSONDecodeError) as error:
        fail(f"archive-invalid:{name}:{type(error).__name__}")


def validate(root: Path, head: str, expected_clone_sha: str, expected_facade_sha: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        fail("expected-source-head-invalid")
    if not all(re.fullmatch(r"[0-9a-f]{64}", v) for v in (expected_clone_sha, expected_facade_sha)):
        fail("expected-digest-invalid")
    front = root / "frontend"
    candidate = read_json(front / "foundation-control-first.candidate.json")
    baseline = read_json(front / "foundation.lock.json")
    product = read_json(front / "package.json")
    lock = read_json(front / "package-lock.json")
    original_wheel = read_json(root / "vendor/onprem-security/candidate.json")
    assert_base = (
        candidate.get("schema_version") == 1
        and candidate.get("status") == "SOURCE_ONLY_UNPUBLISHED_NOT_PRODUCT_ACCEPTED"
        and candidate.get("source_head") == head
        and candidate.get("baseline_lock") == "foundation.lock.json"
        and candidate.get("baseline_version") == baseline.get("version") == "0.1.0-rc.50"
        and baseline.get("schema_version") == 1
        and candidate.get("release_acceptance") is False
        and candidate.get("original_archive_transferred") is False
        and candidate.get("original_wheel_installed") is False
        and original_wheel.get("source_head") == baseline.get("source_head")
    )
    if not assert_base:
        fail("source-state-or-baseline-conflict")

    by_name = {r.get("name"): r for r in candidate.get("packages", []) if isinstance(r, dict)}
    if set(by_name) != set(UPSTREAM_NAMES) or len(candidate.get("packages", [])) != 2:
        fail("candidate-package-set")
    expected_hash = {
        "@datarelay-labs/control-clone": expected_clone_sha,
        "@datarelay-labs/foundation": expected_facade_sha,
    }
    deps = {n: spec for n, spec in product.get("dependencies", {}).items()
            if n.startswith("@datarelay-labs/")}
    baseline_rows = baseline.get("packages", [])
    baseline_by_name = {row.get("name"): row for row in baseline_rows if isinstance(row, dict)}
    if len(baseline_rows) != 10 or set(deps) != set(baseline_by_name) | set(UPSTREAM_NAMES):
        fail("baseline-or-current-package-set")
    packroot = root / ".foundation/packs"
    for name, row in baseline_by_name.items():
        archive = packroot / f"datarelay-labs-{name.partition('/')[2]}-{baseline['version']}.tgz"
        if row.get("archive_sha256") != digest(archive):
            fail(f"baseline-package-digest:{name}")
        if name == "@datarelay-labs/foundation":
            continue  # Installed Foundation facade replaces the old wrapper, RC50 bytes remain preserved.
        if deps.get(name) != f"file:../.foundation/packs/{archive.name}":
            fail(f"baseline-dependency-replaced:{name}")
    for name, filename in UPSTREAM_NAMES.items():
        info = by_name[name]
        expected = expected_hash[name]
        if info.get("version") != "0.1.0-dev" or info.get("filename") != filename or info.get("archive_sha256") != expected:
            fail(f"candidate-lock-identity:{name}")
        if deps.get(name) != f"file:../.foundation/packs/{filename}":
            fail(f"candidate-dependency:{name}")
        archive = packroot / filename
        if digest(archive) != expected:
            fail(f"candidate-archive-digest:{name}")
        validate_tarball(archive, name, "0.1.0-dev")
        if lock.get("packages", {}).get("", {}).get("dependencies", {}).get(name) != deps[name]:
            fail(f"npm-lock-root:{name}")
        if lock.get("packages", {}).get(f"node_modules/{name}", {}).get("resolved") != deps[name].removeprefix("file:") and (
            lock.get("packages", {}).get(f"node_modules/{name}", {}).get("resolved") != deps[name]
        ):
            fail(f"npm-lock-resolved:{name}")
    print(f"CONTROL_FIRST_SOURCE_CANDIDATE=PASS SOURCE_HEAD={head} CANONICAL_NPM=2/2")
    print("CONTROL_FIRST_PRODUCT_NATIVE_ACCEPTANCE=NOT_QUALIFIED")
    print("CONTROL_FIRST_PRIVATE_ORIGINAL_WHEEL=NOT_INSTALLED")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--expected-clone-sha256", required=True)
    parser.add_argument("--expected-facade-sha256", required=True)
    a = parser.parse_args()
    try:
        validate(a.root.resolve(), a.expected_head, a.expected_clone_sha256, a.expected_facade_sha256)
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"CONTROL_FIRST_SOURCE_CANDIDATE=FAIL reason={error}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
