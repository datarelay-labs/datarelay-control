from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs" / "FULL_USER_E2E_SCENARIOS.md"
AGENTS = ROOT / "AGENTS.md"
CAPABILITIES = ROOT / "e2e" / "capabilities" / "data-relay-capabilities.yaml"


def test_full_user_e2e_contract_is_executable_and_release_grade() -> None:
    doc = DOC.read_text(encoding="utf-8")
    agents = AGENTS.read_text(encoding="utf-8")

    assert "Full User E2E 진행해" in doc
    assert "Full User E2E 진행해" in agents
    assert "**Executor:** ChatGPT Chat" in doc
    assert "FIRST_ACTION=ONBOARD_AND_EXECUTE" in doc
    assert "CONTRACT_FULL_READ_REQUIRED=YES" in doc
    assert "CANONICAL_PATH=docs/FULL_USER_E2E_SCENARIOS.md" in doc
    assert "CONTRACT_SHA256=" in doc
    assert "PRIMARY_PERSONA_EXECUTOR=CHATGPT_CHAT" in doc
    assert "SCRIPTED_USER_SCENARIO_EXECUTION=FORBIDDEN" in doc
    assert "WRAPPER_SCRIPT_AS_PERSONA=FORBIDDEN" in doc
    assert "AUTOMATED_HARNESS_ROLE=SUPPLEMENTAL_ONLY" in doc
    assert "WRAPPER_SCRIPT_PASS_IS_USER_PASS=NO" in doc
    assert "A one-shot wrapper such as `run-user-lifecycle-e2e.sh --all` MUST NOT" in doc
    assert "A late manual spot-check" in doc
    assert "SERIAL_IDLE_WITH_RUNNABLE_WORK=FORBIDDEN" in doc
    assert "PERSONA_ORACLE_CONTAMINATION_COUNT=0" in doc
    assert "CURSOR_EXECUTION=FORBIDDEN" in doc
    assert "BROWSER_FIRST=YES" in doc
    assert "ACTUAL_BROWSER_PROCESS_REQUIRED=YES" in doc
    assert "BROWSER_ENGINE=CHROMIUM_OR_CHROME" in doc
    assert "JSDOM_COMPONENT_TEST_SUBSTITUTE=NO" in doc
    assert "API_MUTATION_SUBSTITUTION_FOR_BROWSER_PASS=FORBIDDEN" in doc
    assert "REQUIRE_AUTH=true" in doc
    assert "ULC_REUSE_UI_DIST=0" in doc
    assert "run-scoped GDC_E2E_PID_DIR" in doc
    assert "## 11. Mandatory first-login/password-change proof" in doc
    assert "## 15. Mandatory repetition and sequence variation" in doc
    assert "**Supporting harness:** e2e/user-lifecycle/" in doc
    assert "## 10. Supporting harness and exact-build requirement" in doc
    assert "## 25. Harness authority and fallback audit" in doc
    assert "## 26. Machine-derived closure validation" in doc
    assert "## 28. Release qualification — mandatory two-test order" in doc
    assert "## 31. Mandatory offboarding" in doc
    assert "BROWSER_FEATURE_SCENARIO_RECONCILIATION_REQUIRED=YES" in doc
    assert "FULL_USER_E2E_REQUIRED=YES" in doc
    assert "MACHINE_QUALIFICATION_PASS_REQUIRED_FIRST=NO" in doc
    assert "CANDIDATE_FREEZE_REQUIRED_FIRST=NO" in doc
    assert "FINAL_USER_TEST_HEAD_BECOMES_RELEASE_CANDIDATE=YES" in doc
    assert "SAME_EXACT_CANDIDATE=YES" in doc
    assert "CANDIDATE_HEAD=" in doc
    assert "technical field names the exact audit HEAD under test" in doc
    assert "AUDIT_HEAD=" not in doc

    for number in range(1, 25):
        assert f"FUE-{number:03d}" in doc

    assert "One Stream → Many Routes → Many Destinations" in doc
    assert "Route Processing is the only supported runtime" in doc
    assert "Runtime Is Truth" in doc
    assert "Phase E/F are outside Control release scope" in doc

def test_full_user_e2e_supported_capability_anchors_match_manifest() -> None:
    doc = DOC.read_text(encoding="utf-8")
    manifest = yaml.safe_load(CAPABILITIES.read_text(encoding="utf-8"))

    for group in ("sources", "destinations", "authentication"):
        supported = [
            str(row["id"])
            for row in manifest[group]
            if row.get("status") == "SUPPORTED"
        ]
        for capability_id in supported:
            assert capability_id in doc, (
                f"{group} capability {capability_id} is SUPPORTED in the manifest "
                "but missing from the Full User E2E maintenance anchors"
            )

    for group in ("sources", "destinations", "authentication"):
        out_of_scope = {
            str(row["id"])
            for row in manifest[group]
            if row.get("status") == "OUT_OF_SCOPE"
        }
        assert not any(capability_id in doc for capability_id in out_of_scope)
