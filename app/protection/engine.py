"""Path-targeted protection engine for enriched event batches."""

from __future__ import annotations

import time

from app.protection.field_path_parser import parse_protection_path
from app.runtime.copy_utils import copy_event_dict, copy_events
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.protection.modes import apply_protection_mode
from app.protection.models import PROTECTION_MODE_DROP_FIELD, PROTECTION_MODE_TOKENIZATION, StreamProtectionRule


@dataclass
class ProtectionFieldWarning:
    field_path: str
    rule_id: int | None
    error_message: str

    def to_log_fields(self) -> dict[str, Any]:
        return {
            "field_path": self.field_path,
            "rule_id": self.rule_id,
            "error_message": self.error_message,
            "status": "FIELD_PROTECTION_WARNING",
        }


@dataclass
class ProtectBatchResult:
    events: list[dict[str, Any]]
    masked_field_applications: int = 0
    rules_applied: int = 0
    warning_count: int = 0
    warnings: list[ProtectionFieldWarning] = field(default_factory=list)
    duration_ms: int = 0
    tokenization_batch_items: int = 0
    tokenization_cache_hits: int = 0
    tokenization_created: int = 0


def protection_enabled() -> bool:
    return bool(settings.GDC_PROTECTION_ENABLED)


def parse_field_path_segments(field_path: str) -> list[str | int]:
    """Decode a definite Protection field path without losing escaped keys."""
    return parse_protection_path(field_path)


def _hmac_key_for_stream(stream_id: int) -> bytes:
    secret = str(settings.GDC_PROTECTION_HASH_SALT or "").encode("utf-8")
    if not secret:
        secret = b"gdc-protection-default-salt"
    return f"{stream_id}:".encode("utf-8") + secret


def _collect_leaf_values_at_segments(
    node: Any,
    segments: list[str | int],
    seg_index: int,
) -> list[Any]:
    if seg_index >= len(segments):
        return []

    seg = segments[seg_index]
    is_last = seg_index == len(segments) - 1

    if isinstance(seg, int):
        if not isinstance(node, list) or not -len(node) <= seg < len(node):
            return []
        item = node[seg]
        return [item] if is_last else _collect_leaf_values_at_segments(item, segments, seg_index + 1)


    if seg == "[]":
        if not isinstance(node, list):
            return []
        values: list[Any] = []
        for item in node:
            values.extend(_collect_leaf_values_at_segments(item, segments, seg_index + 1))
        return values

    if is_last:
        if isinstance(node, dict) and seg in node:
            return [node[seg]]
        return []

    if not isinstance(node, dict) or seg not in node:
        return []

    child = node[seg]
    next_seg = segments[seg_index + 1] if seg_index + 1 < len(segments) else None
    if next_seg == "[]":
        if not isinstance(child, list):
            return []
        values = []
        for item in child:
            values.extend(_collect_leaf_values_at_segments(item, segments, seg_index + 2))
        return values

    if isinstance(child, (dict, list)):
        return _collect_leaf_values_at_segments(child, segments, seg_index + 1)
    return []


def collect_tokenization_targets(
    events: list[dict[str, Any]],
    rules: list[StreamProtectionRule],
) -> list[dict[str, str]]:
    """Gather distinct tokenization values across a batch before vault lookup."""

    enabled = [
        r
        for r in rules
        if bool(getattr(r, "enabled", True))
        and str(getattr(r, "protection_mode", "")) == PROTECTION_MODE_TOKENIZATION
    ]
    if not enabled:
        return []

    seen: set[tuple[str, str]] = set()
    items: list[dict[str, str]] = []
    for raw in events:
        if not isinstance(raw, dict):
            continue
        for rule in enabled:
            segments = parse_field_path_segments(str(rule.field_path))
            if not segments:
                continue
            # Never prefetch or mint an identity token for an ambiguous legacy
            # path that will be rejected by Protection on final Route output.
            if _legacy_path_has_literal_dotted_member(raw, str(rule.field_path), segments):
                continue
            for value in _collect_leaf_values_at_segments(raw, segments, 0):
                if not isinstance(value, str):
                    continue
                canonical = value.strip()
                if not canonical:
                    continue
                key = (str(rule.field_path), canonical)
                if key in seen:
                    continue
                seen.add(key)
                items.append({"field_path": str(rule.field_path), "original_value": canonical})
    return items


def _drop_at_segments(
    node: Any,
    segments: list[str | int],
    seg_index: int,
) -> int:
    if seg_index >= len(segments):
        return 0

    seg = segments[seg_index]
    is_last = seg_index == len(segments) - 1

    if isinstance(seg, int):
        if not isinstance(node, list) or not -len(node) <= seg < len(node):
            return 0
        if is_last:
            node.pop(seg)
            return 1
        return _drop_at_segments(node[seg], segments, seg_index + 1)


    if seg == "[]":
        if not isinstance(node, list):
            return 0
        total = 0
        for item in node:
            total += _drop_at_segments(item, segments, seg_index + 1)
        return total

    if is_last:
        if isinstance(node, dict) and seg in node:
            del node[seg]
            return 1
        return 0

    if not isinstance(node, dict) or seg not in node:
        return 0

    child = node[seg]
    next_seg = segments[seg_index + 1] if seg_index + 1 < len(segments) else None
    if next_seg == "[]":
        if not isinstance(child, list):
            return 0
        total = 0
        for item in child:
            total += _drop_at_segments(item, segments, seg_index + 2)
        return total

    return _drop_at_segments(child, segments, seg_index + 1)


def _apply_at_segments(
    node: Any,
    segments: list[str | int],
    seg_index: int,
    *,
    mode: str,
    stream_id: int,
    hmac_key: bytes,
    db: Session | None,
    field_path: str,
    token_map: dict[tuple[str, str], str] | None = None,
) -> int:
    if seg_index >= len(segments):
        return 0

    seg = segments[seg_index]
    is_last = seg_index == len(segments) - 1

    if isinstance(seg, int):
        if not isinstance(node, list) or not -len(node) <= seg < len(node):
            return 0
        if is_last:
            node[seg] = apply_protection_mode(
                node[seg], mode, stream_id=stream_id, hmac_key=hmac_key,
                db=db, field_path=field_path, token_map=token_map,
            )
            return 1
        return _apply_at_segments(
            node[seg], segments, seg_index + 1,
            mode=mode, stream_id=stream_id, hmac_key=hmac_key,
            db=db, field_path=field_path, token_map=token_map,
        )


    if seg == "[]":
        if not isinstance(node, list):
            return 0
        total = 0
        for item in node:
            total += _apply_at_segments(
                item,
                segments,
                seg_index + 1,
                mode=mode,
                stream_id=stream_id,
                hmac_key=hmac_key,
                db=db,
                field_path=field_path,
                token_map=token_map,
            )
        return total

    if is_last:
        if isinstance(node, dict) and seg in node:
            node[seg] = apply_protection_mode(
                node[seg],
                mode,
                stream_id=stream_id,
                hmac_key=hmac_key,
                db=db,
                field_path=field_path,
                token_map=token_map,
            )
            return 1
        return 0

    if not isinstance(node, dict) or seg not in node:
        return 0

    child = node[seg]
    next_seg = segments[seg_index + 1] if seg_index + 1 < len(segments) else None
    if next_seg == "[]":
        if not isinstance(child, list):
            return 0
        total = 0
        for item in child:
            total += _apply_at_segments(
                item,
                segments,
                seg_index + 2,
                mode=mode,
                stream_id=stream_id,
                hmac_key=hmac_key,
                db=db,
                field_path=field_path,
                token_map=token_map,
            )
        return total

    if isinstance(child, (dict, list)):
        return _apply_at_segments(
            child,
            segments,
            seg_index + 1,
            mode=mode,
            stream_id=stream_id,
            hmac_key=hmac_key,
            db=db,
            field_path=field_path,
            token_map=token_map,
        )
    return 0


def _quoted_selector_flags(field_path: str) -> list[bool]:
    """Mark selector tokens that explicitly quote object-member boundaries.

    Parsing and field value validation remain owned by parse_protection_path.
    This secondary lexical scan only records whether each segment was quoted;
    it does not interpret the member value, Unicode escapes, or array indexes.
    """
    value = str(field_path).strip()
    if not value.startswith("$"):
        value = "$." + value
    i = 1
    flags: list[bool] = []
    while i < len(value):
        if value[i] == ".":
            i += 1
            while i < len(value) and value[i] not in ".[":
                i += 1
            flags.append(False)
        elif value[i] == "[":
            if i + 1 < len(value) and value[i + 1] in ("'", '"'):
                quote = value[i + 1]
                i += 2
                while i < len(value):
                    if value[i] == '\\':
                        i += 2
                    elif value[i] == quote:
                        i += 1
                        break
                    else:
                        i += 1
                if i >= len(value) or value[i] != "]":
                    raise ValueError("Malformed quoted Protection selector")
                i += 1
                flags.append(True)
            else:
                end = value.find("]", i + 1)
                if end < 0:
                    raise ValueError("Unclosed Protection selector")
                i = end + 1
                flags.append(False)
        else:
            raise ValueError("Unexpected Protection selector boundary")
    return flags


def _legacy_path_has_literal_dotted_member(
    event: dict[str, Any],
    field_path: str,
    segments: list[str | int],
) -> bool:
    """Detect lossy historical unquoted paths before applying policy.

    A stored legacy path like $.user.email may have originated from either a
    literal key "user.email" or nested user→email. If either representation
    could match a literal dotted key, never guess and silently deliver data.
    Explicit RFC-quoted selectors have unambiguous intent and are exempt.
    """
    flags = _quoted_selector_flags(field_path)
    if len(flags) != len(segments):
        # A validated selector should always yield the same number of tokens.
        # Refuse ambiguous cases instead of guessing a lossy interpretation.
        raise ValueError("Protection selector boundary mismatch")

    def could_alias(node: Any, index: int) -> bool:
        if index >= len(segments):
            return False
        head = segments[index]
        if head == "[]":
            return isinstance(node, list) and any(
                could_alias(item, index + 1) for item in node
            )
        if isinstance(head, int):
            return (
                isinstance(node, list)
                and -len(node) <= head < len(node)
                and could_alias(node[head], index + 1)
            )
        if not isinstance(node, dict):
            return False
        parts: list[str] = []
        if not flags[index]:
            for offset in range(index, len(segments)):
                segment = segments[offset]
                # Only adjacent *unquoted* dotted selectors could have been
                # generated by the historical lossy field-path walker.
                if not isinstance(segment, str) or segment == "[]" or flags[offset]:
                    break
                parts.append(segment)
                if len(parts) >= 2 and ".".join(parts) in node:
                    return True
        if head in node:
            return could_alias(node[head], index + 1)
        return False

    return could_alias(event, 0)


def apply_rule_to_event(
    event: dict[str, Any],
    rule: StreamProtectionRule | Any,
    *,
    db: Session | None = None,
    token_map: dict[tuple[str, str], str] | None = None,
) -> tuple[int, ProtectionFieldWarning | None]:
    try:
        segments = parse_field_path_segments(str(rule.field_path))
    except Exception as exc:
        return 0, ProtectionFieldWarning(
            field_path=str(rule.field_path),
            rule_id=int(getattr(rule, "id", 0) or 0) or None,
            error_message=str(exc),
        )
    if not segments:
        return 0, ProtectionFieldWarning(
            field_path=str(rule.field_path),
            rule_id=int(getattr(rule, "id", 0) or 0) or None,
            error_message="empty field_path segments",
        )
    if _legacy_path_has_literal_dotted_member(event, str(rule.field_path), segments):
        return 0, ProtectionFieldWarning(
            field_path=str(rule.field_path),
            rule_id=int(getattr(rule, "id", 0) or 0) or None,
            error_message=(
                "ambiguous legacy field path: literal dotted member could "
                "bypass protection; use explicit quoted selector"
            ),
        )
    hmac_key = _hmac_key_for_stream(int(rule.stream_id))
    try:
        if str(rule.protection_mode) == PROTECTION_MODE_DROP_FIELD:
            count = _drop_at_segments(event, segments, 0)
            return count, None
        count = _apply_at_segments(
            event,
            segments,
            0,
            mode=str(rule.protection_mode),
            stream_id=int(rule.stream_id),
            hmac_key=hmac_key,
            db=db,
            field_path=str(rule.field_path),
            token_map=token_map,
        )
        return count, None
    except Exception as exc:
        return 0, ProtectionFieldWarning(
            field_path=str(rule.field_path),
            rule_id=int(getattr(rule, "id", 0) or 0) or None,
            error_message=str(exc),
        )


def protect_batch(
    events: list[dict[str, Any]],
    rules: list[StreamProtectionRule],
    *,
    stream_id: int,
    db: Session | None = None,
    ephemeral_rules: list[Any] | None = None,
) -> ProtectBatchResult:
    if not events:
        return ProtectBatchResult(events=[])

    enabled = [r for r in rules if bool(getattr(r, "enabled", True))]
    persisted_paths = {str(r.field_path) for r in enabled}
    extra = [
        r
        for r in (ephemeral_rules or [])
        if bool(getattr(r, "enabled", True)) and str(getattr(r, "field_path", "")) not in persisted_paths
    ]
    enabled = enabled + extra
    if not protection_enabled() or not enabled:
        return ProtectBatchResult(
            events=[copy_event_dict(ev) if isinstance(ev, dict) else ev for ev in events]
        )

    started = time.monotonic()
    out_events: list[dict[str, Any]] = []
    masked_total = 0
    warnings: list[ProtectionFieldWarning] = []
    token_map: dict[tuple[str, str], str] | None = None
    token_batch_items = 0
    token_cache_hits = 0
    token_created = 0

    tokenization_rules = [
        r
        for r in enabled
        if str(getattr(r, "protection_mode", "")) == PROTECTION_MODE_TOKENIZATION
    ]
    if db is not None and tokenization_rules:
        token_targets = collect_tokenization_targets(events, tokenization_rules)
        if token_targets:
            from app.protection.identity_vault import get_or_create_tokens_batch

            token_map, token_stats = get_or_create_tokens_batch(
                db,
                stream_id=int(stream_id),
                items=token_targets,
            )
            token_batch_items = token_stats.batch_items
            token_cache_hits = token_stats.cache_hits
            token_created = token_stats.created

    for raw in events:
        if not isinstance(raw, dict):
            out_events.append(raw)
            continue
        event = copy_event_dict(raw)
        for rule in enabled:
            applied, warn = apply_rule_to_event(event, rule, db=db, token_map=token_map)
            masked_total += applied
            if warn is not None:
                warnings.append(warn)
        out_events.append(event)

    duration_ms = max(0, int((time.monotonic() - started) * 1000))
    return ProtectBatchResult(
        events=out_events,
        masked_field_applications=masked_total,
        rules_applied=len(enabled),
        warning_count=len(warnings),
        warnings=warnings,
        duration_ms=duration_ms,
        tokenization_batch_items=token_batch_items,
        tokenization_cache_hits=token_cache_hits,
        tokenization_created=token_created,
    )
