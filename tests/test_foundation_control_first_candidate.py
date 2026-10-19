"""Source-only Foundation candidate integrity gates, using synthetic fixtures.

Tests do not load unpublished private package bytes and do not touch the real
repository, native authentication or Control user data.
"""
import importlib.util
import io
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/ci/verify-foundation-control-first-candidate.py"
spec = importlib.util.spec_from_file_location("foundation_candidate_verifier", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CANONICAL_HEAD = "a8b633d9275a484e16b13ea05299f398f792a69b"
BASE_HEAD = "746e0a78f8dba782c00eba675099f24f647f1f09"
BASE_NAMES = [
    "auth-ui", "foundation", "foundation-cli", "icons",
    "product-shell", "system-admin-ui", "system-contracts",
    "testkit", "tokens", "ui",
]
CONTROL_FILES = {
    "api/gdcAdmin.ts": b"test-original-api-v1\n",
    "components/settings/admin-settings-page.tsx": b"test-original-settings-v1\n",
}


def source_lineage() -> dict:
    sha = lambda content: hashlib.sha256(content).hexdigest()
    return {
        "source_repository": "datarelay-labs/datarelay-control",
        "pinned_commit": "c" * 40,
        "source_file_count": 2,
        "source_files": [
            {"path": "api/gdcAdmin.ts",
             "upstream_sha256": sha(CONTROL_FILES["api/gdcAdmin.ts"]),
             "local_sha256": sha(CONTROL_FILES["api/gdcAdmin.ts"]),
             "identical_to_control": True},
            {"path": "components/settings/admin-settings-page.tsx",
             "upstream_sha256": sha(CONTROL_FILES["components/settings/admin-settings-page.tsx"]),
             "local_sha256": sha(b"test-adapted-settings-v1\n"),
             "identical_to_control": False},
        ],
        "native_adapter_only_diffs": ["components/settings/admin-settings-page.tsx"],
    }


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def archive(path, name, version, extra=None):
    files = {"package/package.json": json.dumps({
        "name": name, "version": version,
        "dependencies": ({"@datarelay-labs/control-clone": version}
                         if name == "@datarelay-labs/foundation" and version.endswith("-dev") else {}),
        "exports": {".": {"types": "./index.d.ts", "import": "./index.js"}},
    }).encode()}
    files.update(extra or {})
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, "w:gz") as bundle:
        for filename, content in sorted(files.items()):
            info = tarfile.TarInfo(filename)
            info.size = len(content)
            bundle.addfile(info, io.BytesIO(content))


class ControlFirstCandidateVerifier(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dr-control-foundation-candidate-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.front = self.root / "frontend"
        self.packroot = self.root / ".foundation/packs"
        self.packroot.mkdir(parents=True)
        dependencies = {}
        baseline_rows = []
        for short in BASE_NAMES:
            name = f"@datarelay-labs/{short}"
            filename = f"datarelay-labs-{short}-0.1.0-rc.50.tgz"
            tar = self.packroot / filename
            archive(tar, name, "0.1.0-rc.50")
            dependencies[name] = "file:../.foundation/packs/" + filename
            baseline_rows.append({
                "name": name, "archive_sha256": module.digest(tar)
            })
        self.baseline = {"schema_version": 1, "version": "0.1.0-rc.50",
                         "source_head": BASE_HEAD, "packages": baseline_rows}
        write_json(self.front / "foundation.lock.json", self.baseline)
        clone = "datarelay-labs-control-clone-0.1.0-dev.tgz"
        facade = "datarelay-labs-foundation-0.1.0-dev-canonical.tgz"
        self.lineage = source_lineage()
        archive(self.packroot / clone, "@datarelay-labs/control-clone", "0.1.0-dev",
                {"package/dist/index.js": b"x", "package/dist/index.d.ts": b"y",
                 "package/dist/styles.css": b"z",
                 "package/control-source-manifest.json": json.dumps(self.lineage).encode()})
        archive(self.packroot / facade, "@datarelay-labs/foundation", "0.1.0-dev",
                {"package/index.js": b'export * from "@datarelay-labs/control-clone";\n'})
        self.clone_sha = module.digest(self.packroot / clone)
        self.facade_sha = module.digest(self.packroot / facade)
        self.candidate = {
            "schema_version": 1,
            "status": "SOURCE_ONLY_UNPUBLISHED_NOT_PRODUCT_ACCEPTED",
            "source_head": CANONICAL_HEAD,
            "baseline_lock": "foundation.lock.json",
            "baseline_version": "0.1.0-rc.50",
            "original_archive_transferred": False,
            "original_wheel_installed": False,
            "release_acceptance": False,
            "packages": [
                {"name": "@datarelay-labs/control-clone", "filename": clone,
                 "version": "0.1.0-dev", "archive_sha256": self.clone_sha},
                {"name": "@datarelay-labs/foundation", "filename": facade,
                 "version": "0.1.0-dev", "archive_sha256": self.facade_sha},
            ],
        }
        dependencies["@datarelay-labs/control-clone"] = "file:../.foundation/packs/" + clone
        dependencies["@datarelay-labs/foundation"] = "file:../.foundation/packs/" + facade
        self.deps = dependencies
        self.lock_entries = {"": {"dependencies": self.deps}}
        for name in ("@datarelay-labs/control-clone", "@datarelay-labs/foundation"):
            self.lock_entries[f"node_modules/{name}"] = {"resolved": dependencies[name]}
        self.save()
        write_json(self.root / "vendor/onprem-security/candidate.json", {"source_head": BASE_HEAD})

    def save(self):
        write_json(self.front / "foundation-control-first.candidate.json", self.candidate)
        write_json(self.front / "package.json", {"dependencies": self.deps})
        write_json(self.front / "package-lock.json", {"packages": self.lock_entries})

    def verify(self, head=CANONICAL_HEAD, clone_sha=None, facade_sha=None):
        return module.validate(self.root, head, clone_sha or self.clone_sha, facade_sha or self.facade_sha)

    def rewrite_clone_lineage(self):
        clone = self.packroot / self.candidate["packages"][0]["filename"]
        archive(clone, "@datarelay-labs/control-clone", "0.1.0-dev",
                {"package/dist/index.js": b"x", "package/dist/index.d.ts": b"y",
                 "package/dist/styles.css": b"z",
                 "package/control-source-manifest.json": json.dumps(self.lineage).encode()})
        self.clone_sha = module.digest(clone)
        self.candidate["packages"][0]["archive_sha256"] = self.clone_sha
        self.save()

    def control_git_commit(self):
        """Create only a temporary synthetic Git repository; no external credentials."""
        root = self.root
        subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
        for relative, data in CONTROL_FILES.items():
            dest = self.front / "src" / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        subprocess.run(["git", "-C", str(root), "add", "frontend/src"], check=True)
        subprocess.run([
            "git", "-C", str(root), "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture",
        ], check=True)
        head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"]).decode().strip()
        self.lineage["pinned_commit"] = head
        self.rewrite_clone_lineage()
        return head

    def test_source_only_success_does_not_mark_product_acceptance(self):
        self.verify()

    def test_different_external_source_head_rejected(self):
        with self.assertRaisesRegex(ValueError, "source-state-or-baseline-conflict"):
            self.verify(head="a" * 40)

    def test_external_archive_digest_rejected(self):
        with self.assertRaisesRegex(ValueError, "candidate-lock-identity"):
            self.verify(clone_sha="a" * 64)

    def test_tampered_npm_artifact_rejected(self):
        path = self.packroot / self.candidate["packages"][0]["filename"]
        with path.open("ab") as handle:
            handle.write(b"tampering")
        with self.assertRaisesRegex(ValueError, "candidate-archive-digest"):
            self.verify()

    def test_core_visual_dependency_cannot_be_replaced(self):
        self.deps["@datarelay-labs/ui"] = "file:../.foundation/packs/unknown-dev.tgz"
        self.save()
        with self.assertRaisesRegex(ValueError, "baseline-dependency-replaced"):
            self.verify()

    def test_untrusted_new_dependency_rejected(self):
        self.deps["@datarelay-labs/unreviewed"] = "file:/tmp/other.tgz"
        self.save()
        with self.assertRaisesRegex(ValueError, "baseline-or-current-package-set"):
            self.verify()

    def test_claimed_release_acceptance_rejected(self):
        self.candidate["release_acceptance"] = True
        self.save()
        with self.assertRaisesRegex(ValueError, "source-state-or-baseline-conflict"):
            self.verify()

    def test_broken_npm_lock_rejected(self):
        self.lock_entries[""]["dependencies"] = dict(self.deps)
        self.lock_entries[""]["dependencies"]["@datarelay-labs/control-clone"] = "file:wrong.tgz"
        self.save()
        with self.assertRaisesRegex(ValueError, "npm-lock-root"):
            self.verify()

    def test_unsafe_archive_entry_rejected(self):
        suspect = self.root / "unsafe.tgz"
        with tarfile.open(suspect, "w:gz") as bundle:
            info = tarfile.TarInfo("package/../../outside")
            info.size = 1
            bundle.addfile(info, io.BytesIO(b"x"))
        with self.assertRaisesRegex(ValueError, "unsafe-member-path"):
            module.validate_tarball(suspect, "@datarelay-labs/control-clone", "0.1.0-dev")

    def test_embedded_source_lineage_is_verified_in_source_only_gate(self):
        self.verify()
        parsed = module.clone_source_manifest(
            self.packroot / "datarelay-labs-control-clone-0.1.0-dev.tgz"
        )
        self.assertEqual(parsed["source_file_count"], 2)
        self.assertEqual(parsed["native_adapter_only_diffs"],
                         ["components/settings/admin-settings-page.tsx"])

    def test_wrong_control_source_repository_rejected_despite_valid_archive_hash(self):
        self.lineage["source_repository"] = "untrusted/control"
        self.rewrite_clone_lineage()
        with self.assertRaisesRegex(ValueError, "control-source-repository"):
            self.verify()

    def test_forged_or_duplicate_source_path_rejected(self):
        self.lineage["source_files"][0]["path"] = "../outside"
        self.rewrite_clone_lineage()
        with self.assertRaisesRegex(ValueError, "control-source-path"):
            self.verify()
        self.lineage = source_lineage()
        self.lineage["source_files"][0]["path"] = self.lineage["source_files"][1]["path"]
        self.rewrite_clone_lineage()
        with self.assertRaisesRegex(ValueError, "control-source-path"):
            self.verify()

    def test_forged_source_digest_or_adapter_declaration_rejected(self):
        self.lineage["source_files"][0]["upstream_sha256"] = "a" * 64
        self.rewrite_clone_lineage()
        with self.assertRaisesRegex(ValueError, "control-source-digest-fidelity"):
            self.verify()
        self.lineage = source_lineage()
        self.lineage["native_adapter_only_diffs"] = []
        self.rewrite_clone_lineage()
        with self.assertRaisesRegex(ValueError, "control-source-adapter-declaration"):
            self.verify()

    def test_missing_declared_source_row_rejected(self):
        self.lineage["source_files"].pop()
        self.rewrite_clone_lineage()
        with self.assertRaisesRegex(ValueError, "control-source-count"):
            self.verify()

    def test_native_control_ref_gate_uses_immutable_git_not_dirty_checkout(self):
        head = self.control_git_commit()
        clone = self.packroot / "datarelay-labs-control-clone-0.1.0-dev.tgz"
        self.verify()
        module.require_exact_control_source(clone, self.root, head)
        # Dirty worktree bytes never qualify or disqualify historical exact HEAD.
        (self.front / "src/api/gdcAdmin.ts").write_bytes(b"dirty-uncommitted")
        module.require_exact_control_source(clone, self.root, head)

    def test_native_control_ref_gate_blocks_stale_pin_or_changed_code(self):
        head = self.control_git_commit()
        clone = self.packroot / "datarelay-labs-control-clone-0.1.0-dev.tgz"
        self.assertEqual(len(head), 40)
        unrelated = self.root / "README-synthetic"
        unrelated.write_text("new commit without source changes")
        subprocess.run(["git", "-C", str(self.root), "add", "README-synthetic"], check=True)
        subprocess.run([
            "git", "-C", str(self.root), "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.invalid", "commit", "-qm", "new commit",
        ], check=True)
        later = subprocess.check_output(["git", "-C", str(self.root), "rev-parse", "HEAD"]).decode().strip()
        with self.assertRaisesRegex(ValueError, "control-clone-stale-or-incomplete"):
            module.require_exact_control_source(clone, self.root, later)

        (self.front / "src/api/gdcAdmin.ts").write_bytes(b"changed-api-v2")
        subprocess.run(["git", "-C", str(self.root), "add", "frontend/src/api/gdcAdmin.ts"], check=True)
        subprocess.run([
            "git", "-C", str(self.root), "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.invalid", "commit", "-qm", "changed source",
        ], check=True)
        changed = subprocess.check_output(["git", "-C", str(self.root), "rev-parse", "HEAD"]).decode().strip()
        with self.assertRaisesRegex(ValueError, "control-clone-stale-or-incomplete"):
            module.require_exact_control_source(clone, self.root, changed)

    def test_missing_or_malformed_immutable_git_commit_rejected(self):
        self.control_git_commit()
        archive_path = self.packroot / "datarelay-labs-control-clone-0.1.0-dev.tgz"
        with self.assertRaisesRegex(ValueError, "current-control-head-invalid"):
            module.require_exact_control_source(archive_path, self.root, "main-v2")
        with self.assertRaisesRegex(ValueError, "current-control-head-unavailable"):
            module.require_exact_control_source(archive_path, self.root, "a" * 40)


if __name__ == "__main__":
    unittest.main()
