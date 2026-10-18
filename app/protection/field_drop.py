"""Safe field removal sharing the Protection path evaluator.

The legacy independent splitter did not recognize numeric array selectors.
All full-mask, drop-field and tokenization operations must use the same typed
JSONPath segments to avoid inconsistent selection by mode.
"""

from __future__ import annotations

from typing import Any

from app.protection.engine import _drop_at_segments, parse_field_path_segments


def remove_field_at_path(event: dict[str, Any], field_path: str) -> int:
    """Remove a definite/wildcard field path from an event copy in place.

    Invalid paths fail explicitly rather than being coerced to the document
    root. Legacy dotted paths and [] array patterns remain supported.
    """
    segments = parse_field_path_segments(str(field_path))
    if not segments:
        return 0
    return _drop_at_segments(event, segments, 0)
