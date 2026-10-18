"""JSONPath evaluation using jsonpath-ng.

Public helpers operate on ``dict`` roots per API contract. Internal evaluation
against any JSON-like root is used by :mod:`app.parsers.event_extractor`.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from jsonpath_ng import parse as parse_jsonpath
from jsonpath_ng.exceptions import JsonPathParserError

from app.runtime.errors import ParserError

_JSONPATH_ROOT = "$"


def _normalize_jsonpath(path: str | None) -> str:
    """Return a non-empty JSONPath string.

    Policy:
    - ``None``, empty string, or whitespace-only strings are treated as the root
      path ``"$"``, meaning "the whole document".
    - Other paths are stripped of leading/trailing whitespace.

    ``"$"`` selects the root document. ``extract_one`` / ``extract_all`` pass the
    root ``dict`` through unchanged when the normalized path is ``"$"``.
    """

    if path is None:
        return _JSONPATH_ROOT
    stripped = path.strip()
    return _JSONPATH_ROOT if stripped == "" else stripped


@lru_cache(maxsize=1024)
def _compile(path: str) -> Any:
    """Compile JSONPath or raise :class:`ParserError`."""

    try:
        return parse_jsonpath(path)
    except JsonPathParserError as exc:
        raise ParserError(f"Invalid JSONPath expression: {path!r} ({exc})") from exc


def compile_jsonpath(path: str | None) -> Any:
    """Compile normalized JSONPath expression for reuse."""

    normalized = _normalize_jsonpath(path)
    return _compile(normalized)


def find_matches_compiled(compiled_expr: Any, data: Any) -> list[Any]:
    """Return JSONPath matches; an out-of-range negative index matches nothing.

    jsonpath-ng 1.8.0 leaks IndexError for array[-N] when N > array length.
    RFC 9535 requires a missing index to produce an empty nodelist instead.
    Preserve invalid-selector ParserError behavior and other evaluation errors.
    """
    try:
        return compiled_expr.find(data)
    except IndexError:
        return []


def find_values(root: Any, path: str | None) -> list[Any]:
    """Evaluate a normalized JSONPath against any JSON-serializable root.

    Used when the document root may be a ``list`` (e.g. raw API body). Public
    ``extract_one`` / ``extract_all`` restrict roots to ``dict``; this helper
    does not.

    Raises:
        ParserError: If the expression cannot be parsed.
    """

    expr = compile_jsonpath(path)
    return [match.value for match in find_matches_compiled(expr, root)]


def extract_one(data: dict[str, Any], path: str | None, default: Any = None) -> Any:
    """Return the first value matched by ``path``, or ``default`` if none.

    Args:
        data: JSON object used as the JSONPath root (``$``).
        path: JSONPath string; ``None``, ``""``, or whitespace equals ``"$"``.
        default: Returned when there are zero matches.

    Raises:
        ParserError: If ``path`` is syntactically invalid.
        MappingError: If ``data`` is not a ``dict`` (import locally to avoid cycles).

    Nested objects and arrays are supported via jsonpath-ng.
    """

    from app.runtime.errors import MappingError

    if not isinstance(data, dict):
        raise MappingError("extract_one requires root data to be a dict")

    normalized = _normalize_jsonpath(path)
    if normalized == _JSONPATH_ROOT:
        return data

    matches = find_values(data, normalized)
    if not matches:
        return default
    return matches[0]


def extract_all(data: dict[str, Any], path: str | None) -> list[Any]:
    """Return every value matched by ``path`` (possibly empty).

    ``path`` normalization matches :func:`extract_one`. For root ``"$"``,
    returns ``[data]`` so callers always receive a list of values.

    Raises:
        ParserError: If ``path`` is syntactically invalid.
        MappingError: If ``data`` is not a ``dict``.
    """

    from app.runtime.errors import MappingError

    if not isinstance(data, dict):
        raise MappingError("extract_all requires root data to be a dict")

    normalized = _normalize_jsonpath(path)
    if normalized == _JSONPATH_ROOT:
        return [data]

    return find_values(data, normalized)


def extract_one_compiled(compiled_expr: Any, data: dict[str, Any], default: Any = None) -> Any:
    """Return first value from a precompiled JSONPath, or ``default`` when empty.

    Args:
        compiled_expr: Expression returned by :func:`compile_jsonpath`.
        data: JSON object used as evaluation root.
        default: Value returned when there are no matches.

    Raises:
        MappingError: If ``data`` is not a ``dict``.
    """

    from app.runtime.errors import MappingError

    if not isinstance(data, dict):
        raise MappingError("extract_one_compiled requires root data to be a dict")

    matches = find_matches_compiled(compiled_expr, data)
    if not matches:
        return default
    return matches[0].value
