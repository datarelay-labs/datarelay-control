"""Reproducible source-matched DataRelay Control Mapping differential workload.

Example: in a baseline or candidate worktree, run with the same Python/venv::

    PYTHONPATH=.:vendor/onprem-security/<wheel> python scripts/perf/cperf_mapping_differential.py --out /tmp/cases.jsonl

Run both variants with identical seed, compare each JSONL record and SHA-256.
No DB/network access or customer data; synthetic cases only.
"""
import argparse
import copy
import hashlib
import json
import random
from pathlib import Path

from app.mappers.mapper import apply_compiled_mapping, compile_mappings
from app.parsers.event_extractor import extract_events

PATHS = (
    "$.items[0].id",
    "$.items[-1].id",
    "$.items[*].tag",
    "$.items[0].sub.field",
    "$.items[1].sub.field",
    "$.user.id",
    "$.user.role",
    "$.user",
    "$.ctx.keep",
    "$.ctx",
    "$.scalars[-1]",
    "$.scalars[0]",
    "$['strange.key']",
    "$.absent",
    "$.items[99].id",
    "$.items[*]",
    "$.items[0]",
    "$",
)
parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True)
parser.add_argument("--allow-empty", action="store_true")
parser.add_argument("--cases", type=int, default=1200)
parser.add_argument("--seed", type=int, default=46620261124)
parser.add_argument("--compare-to", type=Path, help="fail when generated JSONL differs byte-for-byte")
args = parser.parse_args()
if args.cases <= 0:
    parser.error("--cases must be positive")
rng = random.Random(args.seed)
h = hashlib.sha256()
cases = args.cases
errors = 0
extract_errors = 0
with open(args.out, "w", encoding="utf-8") as fh:
    for case_id in range(cases):
        n = rng.randrange(2, 5)
        item_list = [
            {"id": 9007199254740993 + case_id * 10 + i,
             "tag": rng.choice(("한글", "a", "☃", "é", "🛡️")),
             "sub": {"field": rng.randrange(1, 100), "keep": "ok"},
             "keep": {"timestamp": "2026-11-24", "seq": i}}
            for i in range(n)
        ]
        event = {
            "items": item_list,
            "user": {"id": case_id, "role": "viewer", "audit": "enable"},
            "ctx": {"keep": case_id % 7, "status": "active"},
            "scalars": [1, 2, 3, 4],
            "strange.key": "some str with 🛡️",
            "unrelated": {"keep": [case_id, {"unicode": "서울"}]},
        }
        if args.allow_empty and case_id % 4 == 0:
            event["unrelated"]["empty"] = {"nested": {}}
        if args.allow_empty and case_id % 5 == 0:
            event["untouched_empty"] = []
        original = copy.deepcopy(event)
        count = rng.randrange(1, 7)
        chosen = [rng.choice(PATHS) for _ in range(count)]
        maps = {"out_%s" % i: path for i, path in enumerate(chosen)}
        source_paths = tuple(maps.values())
        if case_id % 13 == 0:
            source_paths = ("$.items[0].id", "$.user.id")  # independent selection fallback
        if case_id % 19 == 0:
            source_paths = ("$.items[0].id",)  # mismatched length fallback
        if case_id % 23 == 0:
            source_paths = ()  # no selections, still pass through
        try:
            out = apply_compiled_mapping(event, compile_mappings(maps), source_json_paths=source_paths)
            result = {"ok": copy.deepcopy(out)}
            if event != original:
                raise RuntimeError("input mutated by mapping")
            # Mutate returned output itself, not a copy, to verify isolation.
            for value in out.values():
                if isinstance(value, dict):
                    value["__probe__"] = True
                    break
                if isinstance(value, list):
                    value.append({"__probe__": True})
                    break
            if isinstance(out.get("items"), list):
                out["items"].append({"__probe__": True})
            if event != original:
                raise RuntimeError("source alias leaked")
        except Exception as exc:
            errors += 1
            result = {"error": type(exc).__name__, "msg": str(exc)}
        if case_id % 17 == 0:
            try:
                extracted = extract_events(
                    {"data": copy.deepcopy(item_list), "context": {"id": case_id}},
                    event_array_path="$.data",
                    event_root_path=None,
                )
                result["extracted"] = extracted
            except Exception as exc:
                extract_errors += 1
                result["extract_error"] = {"type": type(exc).__name__, "message": str(exc)}
        row = {"case": case_id, "mappings": maps, "source_paths": source_paths, "result": result}
        line = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        fh.write(line + "\n")
        h.update(line.encode("utf-8") + b"\n")
if errors or extract_errors:
    raise RuntimeError(f"unexpected mapping/extraction errors: mapping={errors}, extraction={extract_errors}")
if args.compare_to is not None:
    baseline = args.compare_to.read_bytes()
    candidate = Path(args.out).read_bytes()
    if baseline != candidate:
        raise RuntimeError(
            f"source-matched output mismatch: {args.compare_to} != {args.out} "
            f"(baseline sha256={hashlib.sha256(baseline).hexdigest()}, "
            f"candidate sha256={hashlib.sha256(candidate).hexdigest()})"
        )
print(json.dumps({
    "count": cases, "sha256": h.hexdigest(), "allow_empty": args.allow_empty,
    "path_count": len(PATHS), "seed": args.seed,
    "errors": errors + extract_errors,
    "baseline_equal": args.compare_to is not None,
}, sort_keys=True))
