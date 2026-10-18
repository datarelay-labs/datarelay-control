"""Fail-closed verification contract for the signed private RC41 consumer artifact."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/ci/stage-private-foundation-rc41-wheel.py'
SPEC = importlib.util.spec_from_file_location('rc41_stage', SCRIPT)
assert SPEC and SPEC.loader
stage_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage_module)


@pytest.fixture
def fixture_artifact(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    artifact = tmp_path / 'private'
    artifact.mkdir()
    for filename in ('rc41-public-key.pem', 'rc41-provenance.json', 'rc41-provenance.sig', stage_module.WHEEL):
        (artifact / filename).write_bytes(b'fixture-' + filename.encode())
    monkeypatch.setattr(stage_module, 'digest', lambda path: stage_module.TRUSTED_KEY_SHA if path.name == 'rc41-public-key.pem' else stage_module.WHEEL_SHA)
    monkeypatch.setattr(stage_module, 'WHEEL_SIZE', (artifact / stage_module.WHEEL).stat().st_size)
    monkeypatch.setattr(stage_module.subprocess, 'run', lambda *args, **kwargs: type('Result', (), {'returncode': 0})())
    monkeypatch.setattr(stage_module.zipfile, 'ZipFile', lambda path: FakeWheel())
    return artifact


class FakeWheel:
    def __enter__(self): return self
    def __exit__(self, *args): return None
    def namelist(self): return ['datarelay_onprem_security-0.10.0.dev0.dist-info/METADATA']
    def read(self, name): return b'Name: datarelay-onprem-security\nVersion: 0.10.0.dev0\n'


def valid_manifest() -> dict:
    return {'schema': 1, 'repository': stage_module.REPO, 'run_id': int(stage_module.RUN_ID),
            'source_sha': stage_module.SOURCE_SHA, 'version': stage_module.RC_VERSION,
            'signature_algorithm': 'Ed25519', 'wheel': {'file': stage_module.WHEEL, 'sha256': stage_module.WHEEL_SHA}}


def test_valid_signed_metadata_stages_into_new_directory(fixture_artifact: Path, tmp_path: Path):
    (fixture_artifact / 'rc41-provenance.json').write_text(json.dumps(valid_manifest()))
    target = tmp_path / 'new-stage'
    stage_module.stage(fixture_artifact, target)
    assert (target / stage_module.WHEEL).is_file()
    assert (target / 'candidate.json').is_file()
    assert (target / 'SHA256SUMS').is_file()


@pytest.mark.parametrize('field,value', [
    ('repository', 'wrong/repo'), ('run_id', 1), ('source_sha', '0' * 40),
    ('version', '0.1.0-rc.40'), ('signature_algorithm', 'none'),
    ('wheel', {'file': 'wrong.whl', 'sha256': '0' * 64}), ('schema', 2),
])
def test_invalid_signed_metadata_fails_closed(fixture_artifact: Path, tmp_path: Path, field: str, value):
    manifest = valid_manifest()
    manifest[field] = value
    (fixture_artifact / 'rc41-provenance.json').write_text(json.dumps(manifest))
    target = tmp_path / 'rejected'
    with pytest.raises(ValueError, match='verification failed'):
        stage_module.stage(fixture_artifact, target)
    assert not target.exists()


def test_missing_wheel_fails_closed(fixture_artifact: Path, tmp_path: Path):
    (fixture_artifact / 'rc41-provenance.json').write_text(json.dumps(valid_manifest()))
    (fixture_artifact / stage_module.WHEEL).unlink()
    with pytest.raises(ValueError, match='missing/linked artifact'):
        stage_module.stage(fixture_artifact, tmp_path / 'rejected')


def test_symlink_wheel_fails_closed(fixture_artifact: Path, tmp_path: Path):
    (fixture_artifact / 'rc41-provenance.json').write_text(json.dumps(valid_manifest()))
    wheel = fixture_artifact / stage_module.WHEEL
    outside = tmp_path / 'outside'
    shutil.copyfile(wheel, outside)
    wheel.unlink()
    wheel.symlink_to(outside)
    with pytest.raises(ValueError, match='missing/linked artifact'):
        stage_module.stage(fixture_artifact, tmp_path / 'rejected')


def test_existing_target_never_overwritten(fixture_artifact: Path, tmp_path: Path):
    (fixture_artifact / 'rc41-provenance.json').write_text(json.dumps(valid_manifest()))
    target = tmp_path / 'existing'
    target.mkdir()
    sentinel = target / 'preserve.txt'
    sentinel.write_text('preserve')
    with pytest.raises(ValueError, match='output path already exists'):
        stage_module.stage(fixture_artifact, target)
    assert sentinel.read_text() == 'preserve'
