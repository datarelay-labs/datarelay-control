from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs" / "BROWSER_FEATURE_SCENARIO_RECONCILIATION.md"
AGENTS = ROOT / "AGENTS.md"

TRIGGER = "브라우저 상에서 버튼, 기능, 시나리오 연계테스트를 진행해"


def test_browser_reconciliation_contract_is_executable_and_discoverable() -> None:
    doc = DOC.read_text(encoding="utf-8")
    agents = AGENTS.read_text(encoding="utf-8")

    assert TRIGGER in doc
    assert TRIGGER in agents
    assert "**Executor:** ChatGPT Chat" in doc
    assert "FIRST_ACTION=EXECUTE" in doc
    assert "CONTRACT_FULL_READ_REQUIRED=YES" in doc
    assert "CANONICAL_PATH=docs/BROWSER_FEATURE_SCENARIO_RECONCILIATION.md" in doc
    assert "CONTRACT_SHA256=" in doc
    assert "PRIMARY_PERSONA_EXECUTOR=CHATGPT_CHAT" in doc
    assert "SCRIPTED_USER_SCENARIO_EXECUTION=FORBIDDEN" in doc
    assert "WRAPPER_SCRIPT_AS_PERSONA=FORBIDDEN" in doc
    assert "AUTOMATED_HARNESS_ROLE=SUPPLEMENTAL_ONLY" in doc
    assert "a late manual spot-check" in doc
    assert "SERIAL_IDLE_WITH_RUNNABLE_WORK=FORBIDDEN" in doc
    assert "BROWSER_FIRST=YES" in doc
    assert "ACTUAL_BROWSER_PROCESS_REQUIRED=YES" in doc
    assert "BROWSER_ENGINE=CHROMIUM_OR_CHROME" in doc
    assert "JSDOM_COMPONENT_TEST_SUBSTITUTE=NO" in doc
    assert "API_FALLBACK_CAN_CREATE_PASS=NO" in doc
    assert "PRODUCT_SOURCE_EDITS_DURING_ACTIVE_AUDIT=NO" in doc
    assert "### 6.1 Exact audit-HEAD browser lab bring-up" in doc
    assert "### 9.1 State-aware page/control census" in doc
    assert "### 9.2 Routed-page completeness check" in doc
    assert "### 19.1 Status, version, and candidate provenance consistency" in doc
    assert "### 28.1 Machine-derived closure validation" in doc
    assert "### 30.6 Interrupted-run recovery" in doc
    assert "AUTHORITY_ONLY_CAPABILITY" in doc
    assert "/tmp/datarelay-control-browser-reconciliation.lock" in doc
    assert "### 26.1 Scenario terminal status vocabulary" in doc
    assert "SCENARIO_PARTIAL_COUNT=0" in doc
    assert "OPERATOR_FEATURE_BROWSER_GAP_COUNT=0" in doc
    assert "CLOSURE_VALIDATION=PASS" in doc
    assert "### 31.1 Terminal notification" in doc
    assert "This is exhaustive, not representative." in doc
    assert "negative route-surface testing" in doc
    assert "Approval Workflow — submit / approve / reject / activate" in doc
    assert "The active exact audit-HEAD repository MUST remain clean" in doc
    assert "## 30. Offboarding — mandatory" in doc
    assert "## 31. GitHub reporting — mandatory" in doc

    for number in range(1, 21):
        assert f"BFS-{number:03d}" in doc

    assert "PHASE_E_F_EXCLUDED=YES" in doc
    assert "One Stream → Many Routes → Many Destinations" in doc
    assert "Runtime Is Truth" in doc
