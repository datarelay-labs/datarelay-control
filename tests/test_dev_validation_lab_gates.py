"""Unit tests for dev validation lab validation execution gates (no database required)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.config import settings
from app.dev_validation_lab import templates as T
from app.dev_validation_lab.validation_gates import lab_validation_should_execute


def _enable_lab_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", True, raising=False)
    monkeypatch.setattr(settings, "APP_ENV", "development", raising=False)


def test_gate_blocks_lab_template_when_master_flag_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", False, raising=False)
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_S3", True, raising=False)
    row = SimpleNamespace(template_key=T.TK_S3_OBJECT_POLLING)
    assert lab_validation_should_execute(row) is False


def test_gate_blocks_s3_when_flag_off(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_lab_runtime(monkeypatch)
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_S3", False, raising=False)
    row = SimpleNamespace(template_key=T.TK_S3_OBJECT_POLLING)
    assert lab_validation_should_execute(row) is False


def test_gate_allows_s3_when_flag_on(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_lab_runtime(monkeypatch)
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_S3", True, raising=False)
    row = SimpleNamespace(template_key=T.TK_S3_OBJECT_POLLING)
    assert lab_validation_should_execute(row) is True


def test_gate_blocks_database_when_flag_off(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_lab_runtime(monkeypatch)
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_DATABASE_QUERY", False, raising=False)
    row = SimpleNamespace(template_key=T.TK_DB_QUERY_PG)
    assert lab_validation_should_execute(row) is False


def test_gate_allows_database_when_flag_on(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_lab_runtime(monkeypatch)
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_DATABASE_QUERY", True, raising=False)
    row = SimpleNamespace(template_key=T.TK_DB_QUERY_MYSQL)
    assert lab_validation_should_execute(row) is True


def test_gate_blocks_remote_when_flag_off(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_lab_runtime(monkeypatch)
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_REMOTE_FILE", False, raising=False)
    row = SimpleNamespace(template_key=T.TK_REMOTE_SFTP)
    assert lab_validation_should_execute(row) is False


def test_gate_allows_remote_when_flag_on(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_lab_runtime(monkeypatch)
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_REMOTE_FILE", True, raising=False)
    row = SimpleNamespace(template_key=T.TK_REMOTE_SCP)
    assert lab_validation_should_execute(row) is True


def test_gate_non_lab_template_always_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_S3", False, raising=False)
    row = SimpleNamespace(template_key=None)
    assert lab_validation_should_execute(row) is True
    row2 = SimpleNamespace(template_key="custom_operator_check")
    assert lab_validation_should_execute(row2) is True
