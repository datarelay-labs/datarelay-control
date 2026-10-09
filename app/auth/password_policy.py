"""Native Control password policy backed by the Product Foundation security wheel.

The Control account database, bcrypt hashes, login sessions and authorization
remain native. This is an additive reuse of shared validation logic only.
"""

from __future__ import annotations

from datarelay_onprem_security import (
    PasswordIssue,
    PasswordPolicy,
    evaluate_new_password,
)

_FORBIDDEN_PLAINTEXT = "admin"
# Existing Control product contract remains 8–256 until an owner-approved
# password-policy migration and actual two-persona user E2E. Do not silently
# impose the Foundation library's stronger default minimum of 12.
_CONTROL_COMPAT_POLICY = PasswordPolicy(minimum_length=8, maximum_length=256)


def validate_new_platform_password(value: str) -> None:
    """Raise safe English validation errors without echoing password content."""
    assessment = evaluate_new_password(value, policy=_CONTROL_COMPAT_POLICY)
    stripped = value.strip() if isinstance(value, str) else ""
    # The existing Control policy measured a trimmed length; keep that
    # compatibility while using the common security engine for policy checks.
    if (
        PasswordIssue.MISSING in assessment.issues
        or PasswordIssue.TOO_SHORT in assessment.issues
        or len(stripped) < _CONTROL_COMPAT_POLICY.minimum_length
    ):
        raise ValueError("Password must be at least 8 characters.")
    if PasswordIssue.TOO_LONG in assessment.issues or len(stripped) > 256:
        raise ValueError("Password must be at most 256 characters.")
    if PasswordIssue.CONTROL_CHARACTER in assessment.issues:
        raise ValueError("Password may not contain control characters.")
    if stripped.lower() == _FORBIDDEN_PLAINTEXT:
        raise ValueError('The password "admin" is not allowed. Choose a stronger password.')
