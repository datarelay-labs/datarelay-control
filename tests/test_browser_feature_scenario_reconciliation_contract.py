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
    assert "BROWSER_FIRST=YES" in doc
    assert "API_FALLBACK_CAN_CREATE_PASS=NO" in doc
    assert "PRODUCT_SOURCE_EDITS_DURING_ACTIVE_AUDIT=NO" in doc
    assert "### 6.1 Exact-candidate browser lab bring-up" in doc
    assert "### 19.1 Status, version, and candidate provenance consistency" in doc
    assert "## 30. Offboarding — mandatory" in doc
    assert "## 31. GitHub reporting — mandatory" in doc

    for number in range(1, 21):
        assert f"BFS-{number:03d}" in doc

    assert "PHASE_E_F_EXCLUDED=YES" in doc
    assert "One Stream → Many Routes → Many Destinations" in doc
    assert "Runtime Is Truth" in doc
