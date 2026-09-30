from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / ".engineering" / "release.yaml"
TESTS = ROOT / ".engineering" / "tests.yaml"
BROWSER_DOC = ROOT / "docs" / "BROWSER_FEATURE_SCENARIO_RECONCILIATION.md"
FULL_USER_DOC = ROOT / "docs" / "FULL_USER_E2E_SCENARIOS.md"
PRODUCTION_CHECKLIST = ROOT / "docs" / "release" / "production-checklist.md"
RELEASE_READINESS = ROOT / "docs" / "operations" / "release-readiness-checklist.md"


def test_release_requires_both_exhaustive_user_tests() -> None:
    release = yaml.safe_load(RELEASE.read_text(encoding="utf-8"))
    config = release["exhaustive_user_tests"]

    assert release["exhaustive_user_tests_required"] is True
    assert config["executor"] == "CHATGPT_CHAT"
    assert config["exact_head_required"] is True
    assert config["machine_qualification_required_first"] is True
    assert config["same_candidate_required"] is True
    assert config["zero_fail_partial_blocked"] is True
    assert config["ci_contract_validation_only"] is True
    assert config["execution_authority"] == "CHATGPT_WORK_PACKET"
    assert config["evidence_authority"] == "ACTIVE_RELEASE_WORK_PACKET"
    assert config["order"] == [
        "BROWSER_FEATURE_SCENARIO_RECONCILIATION",
        "FULL_USER_E2E",
    ]

    browser = config["gates"]["BROWSER_FEATURE_SCENARIO_RECONCILIATION"]
    full_user = config["gates"]["FULL_USER_E2E"]
    assert browser == {
        "mandatory": True,
        "contract": "docs/BROWSER_FEATURE_SCENARIO_RECONCILIATION.md",
        "minimum_passes": 1,
    }
    assert full_user == {
        "mandatory": True,
        "contract": "docs/FULL_USER_E2E_SCENARIOS.md",
        "minimum_passes": 1,
    }
    assert BROWSER_DOC.is_file()
    assert FULL_USER_DOC.is_file()

    for checklist in (PRODUCTION_CHECKLIST, RELEASE_READINESS):
        text = checklist.read_text(encoding="utf-8")
        assert "BROWSER_FEATURE_SCENARIO_RECONCILIATION.md" in text
        assert "FULL_USER_E2E_SCENARIOS.md" in text
        assert "same exact candidate HEAD" in text or "동일 exact candidate HEAD" in text


def test_test_manifest_keeps_release_contract_validation() -> None:
    manifest = yaml.safe_load(TESTS.read_text(encoding="utf-8"))
    by_id = {row["id"]: row for row in manifest["scenarios"]}
    row = by_id["PRE-RELEASE-EXHAUSTIVE-USER-TEST-CONTRACT"]
    assert row["release_gate"] is True
    assert row["triggers"] == ["rc", "release"]
    assert "test_exhaustive_user_test_release_contract.py" in row["command"]
    assert "test_browser_feature_scenario_reconciliation_contract.py" in row["command"]
    assert "test_full_user_e2e_contract.py" in row["command"]
