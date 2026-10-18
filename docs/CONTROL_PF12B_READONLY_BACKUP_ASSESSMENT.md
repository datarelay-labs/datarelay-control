# Control PF-12B — Read-only archive byte evidence and recovery blockers

**Status:** Source-only operator-selected offline archive inspection.
Not a scheduled backup, certified disaster recovery, archive encryption, host
restore, signed receipt, customer backup scan or release approval.

## Native ownership and Foundation reuse

Control's existing `scripts/ops/backup-postgres.sh` produces
`gdc-postgres-<UTC>.dump[.gz]` and a named `.sha256` sidecar, with
private artifact permissions. The new product-owned
`app/backup/recovery_evidence.py` verifies a **single explicitly selected**
archive and its adjacent exact-basename sidecar. It streams actual archive
bytes and compares SHA256 rather than merely trusting the declared digest.
A regular archive and sidecar must be private (no group/other permissions);
symlinks, empty data, a mismatched/oversized sidecar, changing archive metadata,
invalid extensions and short/extra digest records fail closed. RED regression
tests further proved that the earlier leaf-only `O_NOFOLLOW` check accepted
an explicitly selected path whose **parent directory** was a symlink. The
adapter now rejects symlinks in every supplied archive/sidecar path component
(including intermediate parent directories) before opening files. This is
read-only filesystem preflight, not immutable provenance or protection
against all filesystem races.

The shared, pre-pinned Foundation PF-12B `BackupEvidence`,
`assess_backup` and `preview_restore` contracts evaluate only a
non-secret opaque projection. The adapter sets **known-only facts**:

- Native archive byte integrity verified against its adjacent checksum.
- Backup kind is operational PostgreSQL archive, not JSON config export.
- Filesystem timestamp is **unverified**, not database backup provenance.
- Backup completion state remains **INCOMPLETE/unverified**; a file plus a
  local sidecar cannot prove an actual successful PostgreSQL `pg_dump` job.
- Encryption/key custody **not verified**; set to false.
- Isolated restore drill, schema compatibility, actor/MFA and recovery
  readiness **not verified**; no positive evidence is invented.
- A matching sidecar is **not** publisher authentication, immutable retention
  or guaranteed file integrity against a malicious writer who controls both.

Consequently `backup_healthy` and
`may_submit_to_restore_authority` remain false. The output exposes only
bounded counters, opaque backup ref, byte digest and explicit blocker names;
the customer file path, database URL, credential, original payload, secret,
archive content and restore shell command are never returned.

## Optional isolated operator inspection

```bash
PYTHONPATH=vendor/onprem-security/datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl:. \
python3 scripts/ops/inspect-backup-evidence.py \
  --archive /explicitly-selected/private/gdc-postgres-YYYYMMDDTHHMMSSZ.dump.gz
```

This illustrative invocation was **not run against an operator archive**.
The source/tests used only ephemeral fake archive bytes, private test files,
and no PostgreSQL socket, Docker daemon or network access. The tool does
not schedule, create, read across a directory, delete, encrypt, restore,
migrate or transmit anything. Errors produce a fixed generic failure code
without echoing arbitrary archive paths.

## Unfinished production acceptance

Still needed: product-owned immutable receipt/revision authority and backup
schedule/persistence; encrypted archive key custody; genuine independent
byte-integrity and signature provenance; real isolated clean-system restore
with application data read-back; latest schema and feature compatibility;
actual disaster-recovery execution/rollback; authorized operator/audit;
Browser and two genuine-user E2E on the same installed HEAD; owner release
acceptance. None are inferred from this inspection.
