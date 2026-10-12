#!/usr/bin/env python3
"""Read-only PF-12B archive byte-integrity and recovery readiness inspection.

Explicit test/operator archive argument only; never runs pg_dump, pg_restore,
Docker, a network request, key decryption or a database migration.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from time import time

from app.backup.recovery_evidence import inspect_backup_archive


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--archive", type=Path, required=True)
    ap.add_argument("--now", type=int, default=None, help="Evaluation epoch UTC seconds; omit for current time")
    args = ap.parse_args()
    try:
        facts = inspect_backup_archive(
            args.archive, now=int(time()) if args.now is None else args.now,
        )
    except (OSError, TypeError, ValueError):
        # Archive filenames and OS errors can contain customer path/host data.
        print("PF12B_BACKUP_EVIDENCE_UNVERIFIED", file=sys.stderr)
        return 2
    print(json.dumps(facts, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
