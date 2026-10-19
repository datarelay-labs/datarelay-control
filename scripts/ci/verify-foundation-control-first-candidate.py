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
import subprocess
import tarfile

UPSTREAM_NAMES = {
    "@datarelay-labs/control-clone": "datarelay-labs-control-clone-0.1.0-dev.tgz",
    "@datarelay-labs/foundation": "datarelay-labs-foundation-0.1.0-dev-canonical.tgz",
}
CONTROL_SOURCE_REPO = "datarelay-labs/datarelay-control"
SHA40 = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")


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


def clone_source_manifest(archive: Path) -> dict:
    """Validate the declared Control code-copy lineage, not runtime acceptance."""
    with tarfile.open(archive, "r:gz") as bundle:
        try:
            member = bundle.getmember("package/control-source-manifest.json")
        except KeyError:
            fail("control-source-manifest-missing")
        if not member.isfile() or not 0 < member.size <= 1_000_000:
            fail("control-source-manifest-size")
        stream = bundle.extractfile(member)
        if stream is None:
            fail("control-source-manifest-unreadable")
        try:
            data = json.load(stream)
        except (UnicodeError, json.JSONDecodeError):
            fail("control-source-manifest-json")
    if not isinstance(data, dict):
        fail("control-source-manifest-type")
    if data.get("source_repository") != CONTROL_SOURCE_REPO:
        fail("control-source-repository")
    pin = data.get("pinned_commit")
    if not isinstance(pin, str) or not SHA40.fullmatch(pin):
        fail("control-source-pin")
    rows = data.get("source_files")
    if (not isinstance(rows, list) or not 1 <= len(rows) <= 1000
            or type(data.get("source_file_count")) is not int
            or data["source_file_count"] != len(rows)):
        fail("control-source-count")
    adapter_paths = data.get("native_adapter_only_diffs")
    if not isinstance(adapter_paths, list) or not all(isinstance(p, str) for p in adapter_paths):
        fail("control-source-adapter-list")
    seen: set[str] = set()
    actual_adapters: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            fail("control-source-row")
        path = row.get("path")
        if not isinstance(path, str) or not path or "\\" in path or "\x00" in path:
            fail("control-source-path")
        pure = PurePosixPath(path)
        if not pure.parts or pure.is_absolute() or ".." in pure.parts or str(pure) != path or path in seen:
            fail("control-source-path")
        seen.add(path)
        upstream, local, same = (row.get("upstream_sha256"),
                                 row.get("local_sha256"),
                                 row.get("identical_to_control"))
        if (not isinstance(upstream, str) or not SHA256.fullmatch(upstream)
                or not isinstance(local, str) or not SHA256.fullmatch(local)
                or type(same) is not bool or same != (upstream == local)):
            fail("control-source-digest-fidelity")
        if not same:
            actual_adapters.add(path)
    if len(adapter_paths) != len(set(adapter_paths)) or set(adapter_paths) != actual_adapters:
        fail("control-source-adapter-declaration")
    return data


def require_exact_control_source(archive: Path, root: Path, expected_head: str) -> None:
    """Optional *installation* gate against an immutable Control Git commit.

    Source-only CI must not call this to claim a newer Control product install.
    """
    if not SHA40.fullmatch(expected_head):
        fail("current-control-head-invalid")
    result = subprocess.run(
        ["git", "-C", str(root), "cat-file", "-t", expected_head],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode != 0 or result.stdout.strip() != b"commit":
        fail("current-control-head-unavailable")
    manifest = clone_source_manifest(archive)
    matching = 0
    missing = 0
    for row in manifest["source_files"]:
        path = "frontend/src/" + row["path"]
        content = subprocess.run(
            ["git", "-C", str(root), "show", f"{expected_head}:{path}"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        if content.returncode != 0:
            missing += 1
        elif hashlib.sha256(content.stdout).hexdigest() == row["upstream_sha256"]:
            matching += 1
    total = len(manifest["source_files"])
    print(f"CONTROL_FIRST_DECLARED_SOURCE_MATCH={matching}/{total} MISSING={missing}")
    print("CONTROL_FIRST_SOURCE_REFERENCE=" + manifest["pinned_commit"])
    print("CONTROL_FIRST_TARGET_CONTROL_HEAD=" + expected_head)
    if matching != total or missing or manifest["pinned_commit"] != expected_head:
        fail("control-clone-stale-or-incomplete")
    print("CONTROL_FIRST_DECLARED_SOURCE_PARITY=PASS")
    print("CONTROL_FIRST_INSTALLED_PRODUCT_ACCEPTANCE=NOT_QUALIFIED")


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
                clone_source_manifest(archive)
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
    parser.add_argument("--require-exact-control-head",
                        help="Optional strict native-install gate; never infer this from a mutable branch name.")
    a = parser.parse_args()
    try:
        validate(a.root.resolve(), a.expected_head, a.expected_clone_sha256, a.expected_facade_sha256)
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"CONTROL_FIRST_SOURCE_CANDIDATE=FAIL reason={error}")
        return 2
    if a.require_exact_control_head:
        try:
            require_exact_control_source(
                a.root / ".foundation/packs" / UPSTREAM_NAMES["@datarelay-labs/control-clone"],
                a.root.resolve(), a.require_exact_control_head,
            )
        except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError) as error:
            print(f"CONTROL_FIRST_NATIVE_SOURCE_PARITY=BLOCK reason={error}")
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
