from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs" / "FULL_USER_E2E_SCENARIOS.md"
AGENTS = ROOT / "AGENTS.md"


def test_full_user_e2e_contract_is_executable_and_release_grade() -> None:
    doc = DOC.read_text(encoding="utf-8")
    agents = AGENTS.read_text(encoding="utf-8")

    assert "Full User E2E 진행해" in doc
    assert "Full User E2E 진행해" in agents
    assert "**Executor:** ChatGPT Chat" in doc
    assert "FIRST_ACTION=ONBOARD_AND_EXECUTE" in doc
    assert "CURSOR_EXECUTION=FORBIDDEN" in doc
    assert "BROWSER_FIRST=YES" in doc
    assert "API_MUTATION_SUBSTITUTION_FOR_BROWSER_PASS=FORBIDDEN" in doc
    assert "REQUIRE_AUTH=true" in doc
    assert "ULC_REUSE_UI_DIST=0" in doc
    assert "run-scoped GDC_E2E_PID_DIR" in doc
    assert "## 11. Mandatory first-login/password-change proof" in doc
    assert "## 15. Mandatory repetition and sequence variation" in doc
    assert "## 25. Harness authority and fallback audit" in doc
    assert "## 26. Machine-derived closure validation" in doc
    assert "## 28. Release qualification — mandatory two-test order" in doc
    assert "## 31. Mandatory offboarding" in doc
    assert "BROWSER_FEATURE_SCENARIO_RECONCILIATION_REQUIRED=YES" in doc
    assert "FULL_USER_E2E_REQUIRED=YES" in doc
    assert "SAME_EXACT_CANDIDATE=YES" in doc

    for number in range(1, 25):
        assert f"FUE-{number:03d}" in doc

    assert "One Stream → Many Routes → Many Destinations" in doc
    assert "Route Processing is the only supported runtime" in doc
    assert "Runtime Is Truth" in doc
    assert "Phase E/F are outside Control release scope" in doc
