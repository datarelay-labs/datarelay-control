#!/usr/bin/env python3
"""Verify Control's immutable offline Foundation npm artifacts.

foundation.lock.json sha256 values are stage-release *file-tree* digests.
package-lock.json sha512 values cover the compressed npm archives. Verify
both independently; never mutate, download, install, or repin packages.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import sys
import tarfile


class IntegrityError(ValueError):
    pass


def _require(value: bool, message: str) -> None:
    if not value:
        raise IntegrityError(message)


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _archive_files(archive: Path) -> dict[str, bytes]:
    contents: dict[str, bytes] = {}
    with tarfile.open(archive, mode="r:gz") as reader:
        for member in reader:
            # Package files are declarative: links and device entries must
            # not be interpreted as ordinary staged files.
            _require(member.isfile() or member.isdir(), f"unsupported-archive-member:{member.name}")
            if member.isdir():
                continue
            _require(member.name.startswith("package/"), f"invalid-archive-root:{member.name}")
            relative = member.name[len("package/"):]
            segments = relative.split("/")
            _require(
                bool(relative) and all(segment not in ("", ".", "..") for segment in segments),
                f"unsafe-archive-path:{member.name}",
            )
            _require(relative not in contents, f"duplicate-archive-member:{relative}")
            source = reader.extractfile(member)
            _require(source is not None, f"missing-archive-member:{relative}")
            contents[relative] = source.read()
    _require("package.json" in contents, f"missing-package-manifest:{archive.name}")
    return contents


def _stage_tree_sha256(contents: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for relative in sorted(contents):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(contents[relative])
        digest.update(b"\x00")
    return digest.hexdigest()


def verify(root: Path) -> int:
    frontend = root / "frontend"
    pinned = _load_json(frontend / "foundation.lock.json")
    npm = _load_json(frontend / "package-lock.json")
    declared = _load_json(frontend / "package.json")
    entries = pinned.get("packages")
    version = pinned.get("version")
    _require(pinned.get("schema_version") == 1, "unsupported-foundation-lock")
    _require(isinstance(version, str) and bool(version), "missing-pinned-version")
    _require(isinstance(entries, list) and len(entries) == 10, "expected-ten-foundation-packages")

    names: set[str] = set()
    for item in entries:
        name = item.get("name")
        _require(isinstance(name, str) and name.startswith("@datarelay-labs/"), "invalid-package-name")
        _require(name not in names, f"duplicate-package:{name}")
        names.add(name)
        archive_name = name.replace("@", "").replace("/", "-") + "-" + version + ".tgz"
        relative_archive = ".foundation/packs/" + archive_name
        archive = frontend / relative_archive
        _require(archive.is_file(), f"missing-archive:{name}")
        _require(declared["dependencies"].get(name) == "file:" + relative_archive, f"dependency-not-pinned:{name}")

        installed = npm["packages"].get("node_modules/" + name, {})
        _require(installed.get("version") == version, f"npm-version-drift:{name}")
        _require(installed.get("resolved") == "file:" + relative_archive, f"npm-source-drift:{name}")
        integrity = installed.get("integrity", "")
        _require(isinstance(integrity, str) and integrity.startswith("sha512-"), f"missing-npm-sha512:{name}")
        try:
            expected_archive_digest = base64.b64decode(integrity.removeprefix("sha512-"), validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise IntegrityError(f"invalid-npm-sha512:{name}") from exc
        actual_archive_digest = hashlib.sha512(archive.read_bytes()).digest()
        _require(
            hmac.compare_digest(actual_archive_digest, expected_archive_digest),
            f"archive-sha512-mismatch:{name}",
        )

        expected_tree = item.get("sha256")
        _require(isinstance(expected_tree, str) and re.fullmatch(r"[0-9a-f]{64}", expected_tree) is not None,
                 f"missing-stage-tree-sha256:{name}")
        contents = _archive_files(archive)
        _require(
            hmac.compare_digest(_stage_tree_sha256(contents), expected_tree),
            f"stage-tree-sha256-mismatch:{name}",
        )
        package_manifest = json.loads(contents["package.json"])
        _require(
            package_manifest.get("name") == name and package_manifest.get("version") == version,
            f"archived-package-identity-mismatch:{name}",
        )
    return len(names)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    try:
        count = verify(args.root.resolve())
    except (IntegrityError, OSError, KeyError, ValueError, tarfile.TarError) as exc:
        print(f"CONTROL_FOUNDATION_PACKAGES=FAIL {exc}", file=sys.stderr)
        return 1
    print(f"CONTROL_FOUNDATION_PACKAGES=PASS {count}/{count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
