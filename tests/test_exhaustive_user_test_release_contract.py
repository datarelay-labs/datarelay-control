from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / ".engineering" / "project.yaml"
RELEASE = ROOT / ".engineering" / "release.yaml"
TESTS = ROOT / ".engineering" / "tests.yaml"
BROWSER_DOC = ROOT / "docs" / "BROWSER_FEATURE_SCENARIO_RECONCILIATION.md"
FULL_USER_DOC = ROOT / "docs" / "FULL_USER_E2E_SCENARIOS.md"
PRODUCTION_CHECKLIST = ROOT / "docs" / "release" / "production-checklist.md"
RELEASE_READINESS = ROOT / "docs" / "operations" / "release-readiness-checklist.md"


def test_release_requires_both_exhaustive_user_tests() -> None:
    project = yaml.safe_load(PROJECT.read_text(encoding="utf-8"))
    release = yaml.safe_load(RELEASE.read_text(encoding="utf-8"))
    config = release["human_equivalent_user_tests"]

    assert project["project"]["user_facing"] is True
    assert project["project"]["primary_user_surface"] == "browser"
    assert release["human_equivalent_user_tests_required"] is True
    assert config["executor"] == "CHATGPT_CHAT"
    assert config["actual_user_surface_required"] is True
    assert config["primary_user_surface"] == "browser"
    assert config["actual_browser_process_required"] is True
    assert config["same_candidate_required"] is True
    assert config["ci_contract_validation_only"] is True
    assert config["exact_head_required"] is True
    assert config["machine_qualification_required_first"] is True
    assert config["zero_fail_partial_blocked"] is True
    assert config["browser_engine"] == "CHROMIUM_OR_CHROME"
    assert config["execution_authority"] == "CHATGPT_WORK_PACKET"
    assert config["evidence_authority"] == "ACTIVE_RELEASE_WORK_PACKET"
    assert config["order"] == [
        "EXACT_HEAD_MACHINE_QUALIFICATION_BASELINE",
        "SURFACE_RECONCILIATION_PASS1",
        "SURFACE_RECONCILIATION_BATCH_REMEDIATION",
        "EXACT_HEAD_MACHINE_REQUALIFICATION_AFTER_BROWSER_REMEDIATION",
        "SURFACE_RECONCILIATION_PASS2",
        "FULL_USER_E2E_PASS1",
        "FULL_USER_E2E_BATCH_REMEDIATION",
        "EXACT_HEAD_MACHINE_REQUALIFICATION_AFTER_FULL_USER_REMEDIATION",
        "SURFACE_RECONCILIATION_REESTABLISH_AFTER_FULL_USER_REMEDIATION",
        "FULL_USER_E2E_PASS2",
        "RELEASE_SPECIFIC_GATES",
        "FINAL_EXACT_HEAD_CI",
        "RELEASE_AUDIT",
    ]

    browser = config["surface_reconciliation"]
    full_user = config["full_user_e2e"]
    assert browser == {
        "mandatory": True,
        "contract": "docs/BROWSER_FEATURE_SCENARIO_RECONCILIATION.md",
        "minimum_passes": 2,
        "batch_remediation_between_passes": True,
        "exhaust_safe_independent_scenarios_before_remediation": True,
    }
    assert full_user == {
        "mandatory": True,
        "contract": "docs/FULL_USER_E2E_SCENARIOS.md",
        "minimum_passes": 2,
        "batch_remediation_between_passes": True,
        "exhaust_safe_independent_scenarios_before_remediation": True,
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
