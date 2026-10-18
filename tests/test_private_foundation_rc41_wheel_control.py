"""Real Control password adapter using an independently verified RC41 wheel."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from unittest.mock import patch
import zipfile

import pytest

PRIVATE_WHEEL = os.environ.get("GDC_FOUNDATION_RC41_WHEEL_PATH", "")
pytestmark = pytest.mark.skipif(
    not PRIVATE_WHEEL,
    reason="Private signed RC41 artifact is only consumed in the isolated authenticated job",
)
SHA = "cad95d8ba2d707690ccdfc8ca097e9e746d8ace0f27d70c1c4c638bc663399b8"


def test_actual_rc41_distribution_is_imported_not_legacy_wheel() -> None:
    import datarelay_onprem_security as shared
    wheel = Path(PRIVATE_WHEEL)
    assert wheel.is_file()
    assert hashlib.sha256(wheel.read_bytes()).hexdigest() == SHA
    # Prove the installed Python module bytes match the pinned private wheel,
    # not merely a same-version legacy package in site-packages.
    with zipfile.ZipFile(wheel) as source:
        source_files = [name for name in source.namelist()
                        if name.startswith("datarelay_onprem_security/") and name.endswith(".py")]
        assert source_files
        for name in source_files:
            relative = name.removeprefix("datarelay_onprem_security/")
            loaded = Path(shared.__file__).parent / relative
            assert loaded.read_bytes() == source.read(name), name
    assert shared.PasswordPolicy(8, 256).minimum_length == 8


def test_control_change_password_delegates_to_actual_rc41() -> None:
    from datarelay_onprem_security import PasswordAssessment, PasswordIssue, PasswordPolicy
    from app.auth.password_policy import validate_new_platform_password
    sentinel = "Rc41PasswordPolicyIntegration987"
    with patch("app.auth.password_policy.evaluate_new_password", return_value=PasswordAssessment(
        False, (PasswordIssue.CONTROL_CHARACTER,)
    )) as shared_validator:
        with pytest.raises(ValueError, match="control characters"):
            validate_new_platform_password(sentinel)
    shared_validator.assert_called_once_with(sentinel, policy=PasswordPolicy(8, 256))
