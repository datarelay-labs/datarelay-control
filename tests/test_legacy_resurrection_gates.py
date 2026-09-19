"""Regression gates that fail if superseded architecture is resurrected."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from app.config import Settings
from app.build_identity import (
    compute_app_source_digest,
    compute_build_source_digest,
    load_build_identity,
)

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
FRONTEND_SRC = ROOT / "frontend" / "src"
DOCS = ROOT / "docs"


def test_route_processing_default_is_canonical_true() -> None:
    assert Settings.model_fields["GDC_ROUTE_PROCESSING_ENABLED"].default is True


def test_route_processing_false_is_rejected_not_coerced(monkeypatch: pytest.MonkeyPatch) -> None:
    """Explicit false must fail closed — never silently become true."""

    monkeypatch.setenv("GDC_ROUTE_PROCESSING_ENABLED", "false")
    with pytest.raises(Exception) as excinfo:
        Settings()
    message = str(excinfo.value)
    assert "GDC_ROUTE_PROCESSING_ENABLED=false is no longer supported" in message
    assert "Remove the obsolete setting or set it to true" in message


def test_legacy_route_payload_modules_remain_removed() -> None:
    banned = [
        APP / "route_classification" / "legacy_payloads.py",
        APP / "route_policy" / "legacy_gates.py",
        APP / "route_protection" / "legacy_payloads.py",
    ]
    for path in banned:
        assert not path.exists(), f"retired module must stay removed: {path}"


def test_stream_runner_has_no_legacy_route_imports() -> None:
    text = (APP / "runners" / "stream_runner.py").read_text(encoding="utf-8")
    for needle in (
        "route_classification.legacy_payloads",
        "route_policy.legacy_gates",
        "route_protection.legacy_payloads",
        "_route_processing_enabled",
        "_apply_stream_global_transform",
    ):
        assert needle not in text, f"prohibited pattern in stream_runner: {needle}"


def test_orphan_wizard_components_stay_removed() -> None:
    banned = [
        "step-data-policy.tsx",
        "step-done.tsx",
        "step-enrichment.tsx",
        "step-mapping.tsx",
        "step-preview.tsx",
        "step-review.tsx",
    ]
    wizard = FRONTEND_SRC / "components" / "streams" / "wizard"
    for name in banned:
        assert not (wizard / name).exists(), f"orphan wizard component resurrected: {name}"


def test_hidden_legacy_streams_table_comment_absent() -> None:
    text = (FRONTEND_SRC / "components" / "streams" / "streams-console.tsx").read_text(encoding="utf-8")
    assert "Legacy flat table" not in text
    assert "kept for virtualized regression tests" not in text


def test_live_docs_do_not_claim_route_processing_default_off() -> None:
    """CURRENT docs must not contradict canonical Route Processing ON."""

    scan_roots = [
        DOCS / "architecture" / "source-of-truth-index.md",
        DOCS / "architecture" / "OSS-v1-ARCHITECTURE.md",
        DOCS / "release" / "KNOWN-LIMITATIONS.md",
        DOCS / "getting-started",
        ROOT / "README.md",
        ROOT / ".env.example",
    ]
    forbidden = (
        "GDC_ROUTE_PROCESSING_ENABLED=false` verified",
        "GDC_ROUTE_PROCESSING_ENABLED` | `false` (default)",
        "defaults False",
        "default False",
        "default `False`",
        "defaults to **`False`** for Route Processing",
    )
    files: list[Path] = []
    for root in scan_roots:
        if root.is_file():
            files.append(root)
        elif root.is_dir():
            files.extend(root.rglob("*"))
    for path in files:
        if not path.is_file():
            continue
        if path.suffix not in {".md", ".txt", ".example", ""} and path.name != ".env.example":
            if path.name != "README.md" and path.suffix not in {".md", ".txt"}:
                continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        # Skip explicitly superseded notices
        if "SUPERSEDED" in text[:500] and "historical" in text[:800].lower():
            continue
        for needle in forbidden:
            assert needle not in text, f"{path}: forbidden claim {needle!r}"


def test_governance_does_not_import_ai_gateway_product_models() -> None:
    text = (APP / "governance" / "service.py").read_text(encoding="utf-8")
    assert "from app.ai_gateway.models import" not in text
    assert "from app.ai_gateway.metrics import" not in text


def test_build_identity_digest_stable() -> None:
    a = compute_build_source_digest()
    b = compute_build_source_digest()
    assert a == b
    assert len(a) == 64
    package = compute_app_source_digest()
    assert len(package) == 64
    ident = load_build_identity()
    assert ident["route_processing_canonical"] is True
    assert ident["live_source_digest"] == a
    assert "git_dirty" in ident


def test_build_source_digest_changes_when_app_source_changes(tmp_path: Path) -> None:
    """Same conceptual commit identity must not hide dirty-tree source drift."""

    repo = tmp_path / "repo"
    (repo / "app").mkdir(parents=True)
    (repo / "alembic").mkdir()
    (repo / "docker").mkdir()
    (repo / "app" / "__init__.py").write_text("# a\n", encoding="utf-8")
    (repo / "alembic.ini").write_text("[alembic]\n", encoding="utf-8")
    (repo / "requirements.txt").write_text("fastapi\n", encoding="utf-8")
    (repo / "docker" / "Dockerfile.api").write_text("FROM scratch\n", encoding="utf-8")

    first = compute_build_source_digest(repo)
    (repo / "app" / "__init__.py").write_text("# b-changed\n", encoding="utf-8")
    second = compute_build_source_digest(repo)
    assert first != second


def test_app_package_has_no_new_ai_gateway_router_mount() -> None:
    text = (APP / "main.py").read_text(encoding="utf-8")
    tree = ast.parse(text)
    mounted = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == "include_router":
                mounted.append(ast.unparse(node))
    joined = "\n".join(mounted)
    assert "ai_gateway" not in joined
    assert "ai_proxy" not in joined
