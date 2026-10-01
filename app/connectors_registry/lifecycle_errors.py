"""Marketplace package lifecycle errors."""

from __future__ import annotations


class LifecycleError(Exception):
    """Raised when a package lifecycle operation is rejected or fails."""

    def __init__(
        self,
        message: str,
        *,
        error_code: str,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.error_code = error_code
        self.details = dict(details or {})
