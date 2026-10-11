"""Control PF-9 consumer: actual shared Foundation wheel and password-path contract."""
from __future__ import annotations

import hashlib
from importlib.metadata import version
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from datarelay_onprem_security import (
    PasswordAssessment, PasswordIssue, PasswordPolicy, evaluate_new_password,
)
from app.auth.password_policy import validate_new_platform_password

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor/onprem-security"
WHEEL_NAME = "datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl"
PINNED_SHA256 = "6c7c4c8b425fb181e0c10c61aa7ec4ea47c24121379db2c5230251a3bdbc40db"


def test_wheel_is_the_immutable_shared_foundation_candidate() -> None:
    pkg = VENDOR / WHEEL_NAME
    assert pkg.stat().st_size == 36276
    assert hashlib.sha256(pkg.read_bytes()).hexdigest() == PINNED_SHA256
    assert version("datarelay-onprem-security") == "0.10.0.dev0"
    manifest = json.loads((VENDOR / "candidate.json").read_text(encoding="utf-8"))
    assert manifest["source_head"] == "59b8199d6182e0bed2b25307736edb4dad32a246"
    assert manifest["wheel"] == WHEEL_NAME
    assert manifest["wheel_sha256"] == PINNED_SHA256
    assert manifest["source_tree_sha256"] == "d6cf7b1df97f3f036cee237c80422c0828b3f0e503962fdc5034bce4fa3d5c47"
    assert (VENDOR / "SHA256SUMS").read_text(encoding="ascii").strip() == (
        PINNED_SHA256 + "  " + WHEEL_NAME
    )


def test_requirements_and_container_install_exact_same_offline_wheel() -> None:
    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert requirements.count("./vendor/onprem-security/" + WHEEL_NAME) == 1
    docker = (ROOT / "docker/Dockerfile.api").read_text(encoding="utf-8")
    assert "COPY vendor/onprem-security ./vendor/onprem-security" in docker
    assert "sha256sum -c SHA256SUMS" in docker
    assert "pip install --no-cache-dir -r requirements.txt" in docker


@pytest.mark.parametrize("password", [
    "Passw0rd",  # exactly legacy eight-character lower bound
    "a" * 256,
    "한글비밀번호123",
    " password9 ",  # Control legacy stripped-length compatibility
])
def test_shared_policy_keeps_control_existing_password_length(password: str) -> None:
    assert evaluate_new_password(password, PasswordPolicy(8, 256)).accepted
    validate_new_platform_password(password)


@pytest.mark.parametrize("password, message", [
    ("", "at least 8"),
    ("admin", "at least 8"),
    (" 1234567 ", "at least 8"),
    (" " * 10, "at least 8"),
    ("a" * 257, "at most 256"),
    ("pa" + chr(0) + "ssword123", "control characters"),
    ("password" + chr(0x202E), "control characters"),
    ("my\npassword123", "control characters"),
])
def test_reject_invalid_password_with_no_plaintext_echo(password: str, message: str) -> None:
    with pytest.raises(ValueError, match=message) as caught:
        validate_new_platform_password(password)
    assert password not in str(caught.value) or not password


def test_runtime_password_validation_delegates_to_shared_policy() -> None:
    sentinel = "SharedValidatorSentinel123"
    with patch(
        "app.auth.password_policy.evaluate_new_password",
        return_value=PasswordAssessment(False, (PasswordIssue.CONTROL_CHARACTER,)),
    ) as common:
        with pytest.raises(ValueError, match="control characters"):
            validate_new_platform_password(sentinel)
    common.assert_called_once()
    args, kwargs = common.call_args
    assert args == (sentinel,)
    assert kwargs["policy"] == PasswordPolicy(8, 256)


def test_shared_package_does_not_enable_unimplemented_mfa_or_host_acl() -> None:
    from datarelay_onprem_security import UserMfaState, ManagementPolicy
    assert UserMfaState().required is False
    assert ManagementPolicy().ssh.enabled is False
    assert ManagementPolicy().web.enabled is False
    # These library defaults DO NOT establish real SSH/Web UI enforcement,
    # enrollment, OTP challenge API or authenticated browser E2E in Control.
