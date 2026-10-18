"""Accurate per-event field-occurrence evidence, additive to legacy observations.

This is a scratch-only candidate for DataRelay Control P0-2.
It does not alter Stream/Route runtime behavior or persist source samples.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any, Mapping

from app.schema_observation.path_walker import collect_paths_from_event


@dataclass(frozen=True)
class OccurrenceBatch:
    present_by_path: dict[str, int]
    sampled_events: int
    complete: bool
    warnings: tuple[str, ...]


def _walk_sample_limit(
    value: Any, *, max_depth: int, max_paths: int
) -> set[str]:
    warnings: set[str] = set()
    budget = [max_paths * 2 + 1]

    def walk(node: Any, depth: int) -> None:
        if budget[0] <= 0:
            warnings.add("node_inspection_limit")
            return
        budget[0] -= 1

        if depth > max_depth:
            warnings.add("depth_limit")
            return
        if isinstance(node, list):
            if len(node) > 3:
                warnings.add("array_sample_limit")
            # Match path walker's first three array members.
            for child in node[:3]:
                walk(child, depth + 1)
        elif isinstance(node, dict):
            for child in node.values():
                if budget[0] <= 0:
                    warnings.add("node_inspection_limit")
                    return
                walk(child, depth + 1)

    walk(value, 0)
    return warnings


def collect_occurrence_batch(
    sample: list[dict[str, Any]],
    *,
    batch_paths: Mapping[str, str],
    max_depth: int,
    max_paths: int,
    event_sample_truncated: bool = False,
    invalid_event_objects: bool = False,
) -> OccurrenceBatch:
    """Count each observed path at most once in each sampled event.

    An array may yield several nodes for one path but only one event presence.
    Complete counts are limited to the sampled Stream event-root; any configured
    truncation is flagged, not silently promoted into an exact baseline.
    """
    counts: Counter[str] = Counter()
    warnings: set[str] = set()
    permitted = set(batch_paths)
    for event in sample:
        fields = collect_paths_from_event(
            event, max_depth=max_depth, max_paths=max_paths
        )
        if len(fields) >= max_paths:
            warnings.add("path_sample_limit")
        warnings.update(
            _walk_sample_limit(event, max_depth=max_depth, max_paths=max_paths)
        )
        for path in permitted.intersection(fields):
            counts[path] += 1

    if event_sample_truncated:
        warnings.add("event_sample_limit")
    if invalid_event_objects:
        warnings.add("non_object_events_ignored")
    if len(permitted) >= max_paths:
        warnings.add("union_path_limit")

    return OccurrenceBatch(
        present_by_path=dict(counts),
        sampled_events=len(sample),
        complete=not warnings,
        warnings=tuple(sorted(warnings)),
    )
