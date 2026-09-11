#!/usr/bin/env python3
"""Deterministic business dataset generator unit tests (no platform required)."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_business_dataset import (  # noqa: E402
    DEFAULT_SEED,
    ENTITY_COUNTS,
    dataset_fingerprint,
    generate,
    main as gen_main,
)


def test_deterministic_same_seed() -> None:
    a = generate(DEFAULT_SEED)
    b = generate(DEFAULT_SEED)
    assert dataset_fingerprint(a) == dataset_fingerprint(b)
    assert a["customers"][0]["customer_id"] == "customer-001"
    assert a["orders"][0]["order_id"] == "order-001"
    assert a["orders"][0]["customer_id"] == "customer-001"


def test_counts() -> None:
    d = generate(DEFAULT_SEED)
    for k, n in ENTITY_COUNTS.items():
        assert len(d[k]) == n, k


def test_different_seed_changes_fingerprint() -> None:
    assert dataset_fingerprint(generate(1)) != dataset_fingerprint(generate(2))


def test_emit_artifacts() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        sys.argv = ["generate_business_dataset.py", "--seed", "42", "--out-dir", str(out)]
        gen_main()
        assert (out / "dataset.json").exists()
        assert (out / "fingerprint.txt").exists()
        assert (out / "postgres" / "shared_business_seed.sql").exists()
        assert (out / "s3" / "customers.ndjson").exists()
        assert (out / "sftp" / "customers.csv").exists()
        assert (out / "http" / "canonical.json").exists()
        assert (out / "webhook" / "events.ndjson").exists()
        data = json.loads((out / "dataset.json").read_text(encoding="utf-8"))
        assert data["_meta"]["fingerprint_sha256"] == (out / "fingerprint.txt").read_text(encoding="utf-8").strip()


def main() -> int:
    tests = [
        test_deterministic_same_seed,
        test_counts,
        test_different_seed_changes_fingerprint,
        test_emit_artifacts,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
