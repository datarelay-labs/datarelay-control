# Control PF-12B — PostgreSQL backup artifact hygiene

**Status:** bounded B5 source-only improvement under Control roadmap #91.
Source reference: Foundation PF-12B `docs/ONPREM_BACKUP_RESTORE_EVIDENCE.md`.
This is **not** backup encryption, immutable DR evidence, verified restore or
release qualification.

## Existing Control capabilities (confirmed by source)

| Surface | Actual product ownership | PF-12B interpretation |
| --- | --- | --- |
| `/workspace/export`, import preview/apply | Portable configuration JSON; additive/clone imports | **configuration_export**, NOT full DR |
| `scripts/ops/backup-postgres.sh` | PostgreSQL `pg_dump -Fc`, optional gzip | Product-native **DR archive candidate** |
| `scripts/ops/restore-postgres.sh` | Explicit confirmation + pre-restore dump + `pg_restore` | Privileged destructive restore; *not run by this work* |
| Administration Backup & Import | Existing Control native preview/role authority | No claim that standalone JSON is DR backup |

PF-12A revision history/diff with secret-free rollback, PF-12B immutable
encrypted recovery identity and independent restore drill, PF-12C signed
offline update provenance and rollback are **not qualified** in Control.

## Verified hygiene improvement

The PostgreSQL backup script previously inherited the invoking process's
umask (e.g. 0022). An archive containing a complete Control database could
be created **0644**, exposing secrets or tenant data to other local users.

Now the backup command sets `umask 077` before creating any artifact,
refuses to overwrite another same-second archive or digest, fails on
zero-byte output, and produces a restrictive 0600
`gdc-postgres-<UTC>.dump[.gz].sha256` sidecar containing the actual SHA256
digest and archive basename. Both success and partial failure files are
private. The script explicitly prints that encryption is **NOT PROVIDED**.

The digest allows **later independent byte-integrity comparison**. A
SHA256 checksum does *not* authenticate a publisher, encrypt a backup,
prove the backup contents are restorable, verify an isolated restore drill,
or authorize a destructive recovery operation. The checksum file must be
protected with the backup; without a pinned trusted signature, an attacker
capable of replacing both files can rewrite the digest.

## Regression evidence and remaining gates

The new source-only tests replace `pg_dump` with a fake executable and
`date` with fixed UTC output, passing only a fake test URL; **no
PostgreSQL socket, live database, or restore command is touched**.
The tests cover both gzip modes, archive/digest read-only mode 0600,
checksum matches actual bytes, refusal to overwrite an existing archive,
partial failed dumps and missing credentials.

Actual Control B5 closure still requires authorized encrypted-at-rest
backups with key custody, reliable retention, actual product-owned
revision/manifest authority, **a successful isolated restore drill with
business data readback**, authenticated actor and MFA, safe rollback,
signed offline update publisher verification and all mandatory browser
and Full User E2E gates. None are claimed by this source change.

Earlier browser audit #410 test catalog cleanup safety denial remains
binding; the isolated fake-pg_dump checks do not interact with that
database, host service, SSH/firewall, or customer storage.
