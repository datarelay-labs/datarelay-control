#!/usr/bin/env python3
"""Stage the exact signed Foundation RC41 wheel in an ephemeral consumer directory.

Never download, publish, or copy this private wheel into the Control source tree.
The caller owns the authenticated acquisition of the approved Actions artifact.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

REPO = "datarelay-labs/datarelay-product-foundation"
SOURCE_SHA = "46ddb60cad8eae7b1718588cd19421e61b5300e7"
SOURCE_TREE_SHA = "5af69c4fe14b2fb9c1c4bd93c802b2ba4a8c4d7284406a6e93e3f96540e45028"
RUN_ID = "38395149689"
RC_VERSION = "0.1.0-rc.41"
WHEEL = "datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl"
WHEEL_SHA = "cad95d8ba2d707690ccdfc8ca097e9e746d8ace0f27d70c1c4c638bc663399b8"
WHEEL_SIZE = 37487
TRUSTED_KEY_SHA = "dd0503f2c5804489da71d2d82e75855e6abc7842ba54185362ea364718c04451"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(ok: bool, what: str) -> None:
    if not ok:
        raise ValueError("Foundation RC41 verification failed: " + what)


def stage(artifact: Path, output: Path) -> None:
    # The trust anchor is the independently pinned public-key digest, not a key
    # provided by an untrusted package alone.
    key = artifact / "rc41-public-key.pem"
    statement = artifact / "rc41-provenance.json"
    signature = artifact / "rc41-provenance.sig"
    wheel = artifact / WHEEL
    for p in (key, statement, signature, wheel):
        require(p.is_file() and not p.is_symlink(), "missing/linked artifact " + p.name)
    require(digest(key) == TRUSTED_KEY_SHA, "untrusted Ed25519 signer")
    signed = subprocess.run(
        ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(key),
         "-rawin", "-in", str(statement), "-sigfile", str(signature)],
        text=True, capture_output=True, check=False,
    )
    require(signed.returncode == 0, "invalid provenance signature")
    manifest = json.loads(statement.read_text(encoding="utf-8"))
    require(manifest.get("schema") == 1, "provenance schema")
    require(manifest.get("repository") == REPO, "source repository")
    require(str(manifest.get("run_id")) == RUN_ID, "source workflow run")
    require(manifest.get("source_sha") == SOURCE_SHA, "source HEAD")
    require(manifest.get("version") == RC_VERSION, "package family version")
    require(manifest.get("signature_algorithm") == "Ed25519", "signing algorithm")
    require(manifest.get("wheel") == {"file": WHEEL, "sha256": WHEEL_SHA}, "wheel provenance")
    require(wheel.stat().st_size == WHEEL_SIZE and digest(wheel) == WHEEL_SHA, "wheel bytes")
    with zipfile.ZipFile(wheel) as bundle:
        paths = bundle.namelist()
        require(any(p.endswith(".dist-info/METADATA") for p in paths), "wheel format")
        meta = bundle.read(next(p for p in paths if p.endswith(".dist-info/METADATA"))).decode()
        require("Name: datarelay-onprem-security\n" in meta, "Python distribution")
        require("Version: 0.10.0.dev0\n" in meta, "Python version")
    # Refuse an existing target: a public checkout's tracked old wheel must never
    # be silently overwritten. Only write into a fresh, caller-owned staging dir.
    require(not output.exists(), "output path already exists")
    output.mkdir(parents=True, mode=0o700)
    shutil.copyfile(wheel, output / WHEEL)
    (output / "SHA256SUMS").write_text(f"{WHEEL_SHA}  {WHEEL}\n", encoding="ascii")
    candidate = {
        "candidate_only": True, "project": "datarelay-onprem-security",
        "repository": REPO, "schema_version": 1,
        "source_head": SOURCE_SHA, "source_tree_sha256": SOURCE_TREE_SHA,
        "version": "0.10.0.dev0", "wheel": WHEEL,
        "wheel_bytes": WHEEL_SIZE, "wheel_sha256": WHEEL_SHA,
    }
    (output / "candidate.json").write_text(
        json.dumps(candidate, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    require(digest(output / WHEEL) == WHEEL_SHA, "staged output mismatch")
    print("FOUNDATION_RC41_SIGNED_WHEEL_STAGE=PASS")
    print("SOURCE_SHA=" + SOURCE_SHA)
    print("WHEEL_SHA256=" + WHEEL_SHA)


def main() -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--artifact-dir", required=True, type=Path)
    cli.add_argument("--output-dir", required=True, type=Path)
    args = cli.parse_args()
    try:
        stage(args.artifact_dir.resolve(), args.output_dir.absolute())
    except (OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
