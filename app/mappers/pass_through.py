"""Unknown field pass-through for basic JSONPath mapping.

After mapped fields are extracted, unmapped source structure is preserved:
- top-level keys not fully consumed
- nested siblings inside partially mapped objects
- array elements with partially mapped fields
"""

from __future__ import annotations

from typing import Any, Iterable

from jsonpath_ng.jsonpath import Child, Fields, Index, Root

from app.parsers.jsonpath_parser import compile_jsonpath, find_matches_compiled
from app.runtime.copy_utils import copy_json_value


def maps_whole_event(source_json_paths: Iterable[str]) -> bool:
    for path in source_json_paths:
        if path.strip() in ("$", ""):
            return True
    return False


def _jsonpath_atoms(expression: Any) -> tuple[Any, ...]:
    """Flatten the parser AST without interpreting key punctuation as syntax."""
    if isinstance(expression, Child):
        return (*_jsonpath_atoms(expression.left), *_jsonpath_atoms(expression.right))
    if isinstance(expression, Root):
        return ()
    return (expression,)


def _concrete_tokens(
    expression: Any,
    *,
    source_event: dict[str, Any] | None = None,
) -> tuple[str | int, ...]:
    """Return tokens for exactly one materialized JSONPath result.

    With the immutable source event, normalize negative array indices to their
    concrete nonnegative locations, *before* deduplicating or deleting paths.
    This is a required distinction between query index and RFC 9535 normalized
    node identity. Bracket-delimited field names remain opaque literal keys.
    """
    tokens: list[str | int] = []
    node: Any = source_event
    for atom in _jsonpath_atoms(expression):
        if isinstance(atom, Fields) and len(atom.fields) == 1:
            key = atom.fields[0]
            if source_event is not None:
                if not isinstance(node, dict) or key not in node:
                    raise ValueError("JSONPath materialized field was not found")
                node = node[key]
            tokens.append(key)
        elif isinstance(atom, Index) and len(atom.indices) == 1:
            index = atom.indices[0]
            if not isinstance(index, int):
                raise ValueError("A JSONPath concrete index must be numeric")
            if source_event is not None:
                if not isinstance(node, list):
                    raise ValueError("JSONPath materialized index is not an array")
                index = index if index >= 0 else len(node) + index
                if not 0 <= index < len(node):
                    raise ValueError("JSONPath materialized index is out of bounds")
                node = node[index]
            tokens.append(index)
        else:
            raise ValueError(
                f"Not an unambiguous concrete JSONPath: {type(atom).__name__}"
            )
    return tuple(tokens)


def parse_jsonpath_segments(path: str) -> list[str | int]:
    """Parse definite paths via the same JSONPath compiler as extraction.

    Non-definite expressions raise rather than masquerading as the root.
    The mapping engine may use multi-match queries; their matches are
    materialized separately by _selected_concrete_paths().
    """
    return list(_concrete_tokens(compile_jsonpath(path)))


def _selected_concrete_paths(
    source_event: dict[str, Any],
    source_json_paths: Iterable[str],
) -> set[tuple[str | int, ...]]:
    selected: set[tuple[str | int, ...]] = set()
    for path in source_json_paths:
        expr = compile_jsonpath(path)
        # Basic Mapping's extract_one_compiled() consumes only the first match.
        # Retain every unconsumed wildcard/union match in pass-through.
        matches = find_matches_compiled(expr, source_event)
        if matches:
            selected.add(_concrete_tokens(matches[0].full_path, source_event=source_event))
    return selected


def _remove_concrete_path(root: dict[str, Any], tokens: tuple[str | int, ...]) -> None:
    if not tokens:
        root.clear()
        return

    node: Any = root
    for part in tokens[:-1]:
        if isinstance(part, int):
            if not isinstance(node, list) or not -len(node) <= part < len(node):
                return
            node = node[part]
        elif isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return

    last = tokens[-1]
    if isinstance(last, int):
        if isinstance(node, list) and -len(node) <= last < len(node):
            node.pop(last)
    elif isinstance(node, dict):
        node.pop(last, None)


def _apply_selected_removals(
    root: dict[str, Any], selected: set[tuple[str | int, ...]]
) -> None:
    if not selected:
        return
    if () in selected:
        root.clear()
        return

    # Mark ONLY containers on consumed paths. Existing unrelated empty objects,
    # arrays, and their ancestors are not candidates for accidental pruning.
    affected: dict[int, dict[str, Any] | list[Any]] = {}
    for path in selected:
        cursor: Any = root
        for part in path[:-1]:
            if isinstance(part, int):
                if not isinstance(cursor, list) or not -len(cursor) <= part < len(cursor):
                    break
                cursor = cursor[part]
            elif isinstance(cursor, dict) and part in cursor:
                cursor = cursor[part]
            else:
                break
            if isinstance(cursor, (dict, list)):
                affected[id(cursor)] = cursor

    def ordering(tokens: tuple[str | int, ...]) -> tuple[Any, ...]:
        # Deep selections before ancestor selections. For a shared array parent,
        # delete high indexes before low ones to avoid moving later targets.
        return (
            len(tokens),
            tuple((1, item) if isinstance(item, int) else (0, item) for item in tokens),
        )

    for tokens in sorted(selected, key=ordering, reverse=True):
        _remove_concrete_path(root, tokens)

    def prune_only_affected(node: Any) -> None:
        if isinstance(node, dict):
            for key, child in list(node.items()):
                prune_only_affected(child)
                if id(child) in affected and isinstance(child, (dict, list)) and not child:
                    del node[key]
        elif isinstance(node, list):
            for index in range(len(node) - 1, -1, -1):
                child = node[index]
                prune_only_affected(child)
                if id(child) in affected and isinstance(child, (dict, list)) and not child:
                    node.pop(index)

    prune_only_affected(root)


def _is_empty_container(value: Any) -> bool:
    if isinstance(value, dict):
        return len(value) == 0
    if isinstance(value, list):
        return len(value) == 0
    return False


def _prune_empty_containers(node: Any) -> None:
    if isinstance(node, dict):
        for key in list(node.keys()):
            child = node[key]
            _prune_empty_containers(child)
            if _is_empty_container(child):
                del node[key]
    elif isinstance(node, list):
        for idx in range(len(node) - 1, -1, -1):
            child = node[idx]
            _prune_empty_containers(child)
            if _is_empty_container(child):
                node.pop(idx)


def remove_at_jsonpath(root: dict[str, Any], path: str) -> None:
    """Remove only the fields matched by the actual JSONPath query.

    An unmatched or malformed non-root path must never erase the entire event.
    """
    selected = _selected_concrete_paths(root, (path,))
    _apply_selected_removals(root, selected)


def deep_merge_pass_through(output: dict[str, Any], residual: dict[str, Any]) -> dict[str, Any]:
    """Merge ``residual`` into ``output`` without overwriting existing output values."""

    merged = copy_json_value(output)

    def merge_into(target: Any, source: Any) -> None:
        if not isinstance(target, dict) or not isinstance(source, dict):
            return
        for key, src_val in source.items():
            if key not in target:
                target[key] = copy_json_value(src_val)
                continue
            tgt_val = target[key]
            if isinstance(tgt_val, dict) and isinstance(src_val, dict):
                merge_into(tgt_val, src_val)
            elif isinstance(tgt_val, list) and isinstance(src_val, list):
                merge_arrays(tgt_val, src_val)

    def merge_arrays(target: list[Any], source: list[Any]) -> None:
        for idx, src_item in enumerate(source):
            if idx >= len(target):
                target.append(copy_json_value(src_item))
                continue
            tgt_item = target[idx]
            if isinstance(tgt_item, dict) and isinstance(src_item, dict):
                merge_into(tgt_item, src_item)
            elif isinstance(tgt_item, list) and isinstance(src_item, list):
                merge_arrays(tgt_item, src_item)

    merge_into(merged, residual)
    return merged


def build_residual_after_mapping(
    event: dict[str, Any], source_json_paths: Iterable[str]
) -> dict[str, Any]:
    residual = copy_json_value(event)
    # Resolve ALL selections against the original event before any removal.
    # Parent deletion, overlapping paths, and array index shifts then cannot
    # silently alter which source fields were considered mapped.
    selected = _selected_concrete_paths(event, source_json_paths)
    _apply_selected_removals(residual, selected)
    return residual


def merge_unknown_field_pass_through(
    event: dict[str, Any],
    output: dict[str, Any],
    source_json_paths: Iterable[str],
) -> dict[str, Any]:
    """Copy unmapped source structure into ``output`` (non-mutating merge)."""

    if not isinstance(event, dict):
        return output

    if maps_whole_event(source_json_paths):
        return output

    residual = build_residual_after_mapping(event, source_json_paths)
    if not residual:
        return output

    return deep_merge_pass_through(output, residual)


# Backward-compatible helpers used in tests / diagnostics.
def mapped_top_level_keys(source_json_paths: Iterable[str]) -> set[str]:
    roots: set[str] = set()
    for path in source_json_paths:
        atoms = _jsonpath_atoms(compile_jsonpath(path))
        if atoms and isinstance(atoms[0], Fields) and len(atoms[0].fields) == 1:
            roots.add(atoms[0].fields[0])
    return roots


__all__ = [
    "build_residual_after_mapping",
    "deep_merge_pass_through",
    "merge_unknown_field_pass_through",
    "mapped_top_level_keys",
    "maps_whole_event",
    "parse_jsonpath_segments",
    "remove_at_jsonpath",
]
