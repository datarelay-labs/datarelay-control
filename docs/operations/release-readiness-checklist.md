# 릴리스 준비·업그레이드 운영 체크리스트

프로덕션 또는 스테이징에서 **GDC Platform** 이미지·스키마를 올릴 때의 표준 절차입니다.  
(코드 변경 없이 검증만 할 때도 동일한 순서로 “드라이런”할 수 있습니다.)

**관련 문서**

- `docs/deployment/backup-restore.md` — Compose 백업/복원 스크립트
- `docs/operations/migration-recovery-runbook.md` — 고아 리비전, `alembic stamp`, 복구
- `docs/operations/migration-integrity-validation.md` — `migration_integrity`, API 재시작, 시드
- `docs/operations/auth-session-operations.md` — JWT, `token_version`, 로그인 검증
- `docs/testing/backend-full-test.md` — 호스트 `pytest`와 **`gdc_pytest`** 분리

**금지(정책과 동일)**  
`StreamRunner` 변경, `delivery_logs` 스키마 임의 변경, Alembic 마이그레이션 파일 수정, DB 리셋/`docker compose down -v`, 라이브 DB `TRUNCATE`, `git reset` 없이 이력 맞추기 시도 등은 하지 않습니다.

---

## 0. 환경 변수·Compose 정렬

| 항목 | 확인 |
|------|------|
| `GDC_RELEASE_COMPOSE_FILE` | 사용 중인 스택과 일치 (`docker-compose.platform.yml` vs `deploy/docker-compose.https.yml` 등) |
| 카탈로그 이름 | `docker-compose.platform.yml` → **`gdc`**. `deploy/docker-compose.https.yml` → 일반적으로 **`gdc`** (`migration-recovery-runbook.md` 표 참고) |
| 백업·복원 DB 이름 | `backup-before-upgrade.sh` / `restore.sh`는 **`GDC_RELEASE_COMPOSE_FILE`에 맞춰 `POSTGRES_DB`를 자동 추론**합니다(`docker compose … config`). **`GDC_BACKUP_DB_NAME` / `GDC_RESTORE_DB_NAME`는 선택**이며, Compose와 다르면 경고가 출력됩니다. |
| 호스트 `.env`의 `DATABASE_URL` | 호스트에서 Alembic/스크립트를 돌릴 때는 Compose가 주입하는 DB와 **동일 카탈로그**를 가리키는지 확인 (`install.sh`의 lab 경고 참고). |

---

## 1. 사전 업그레이드 (Pre-upgrade)

- [ ] **변경 범위·릴리스 노트** 확인 (이미지 태그 / Git 태그 / 구성 변경).
- [ ] **유지보수 창** 및 롤백 담당·연락망 확정.
- [ ] **읽기 전용 마이그레이션 점검** (로컬 또는 CI에서 이미 통과했다면 스테이징에서 한 번 더 권장):

  ```bash
  ./scripts/ops/validate-migrations.sh --pre-upgrade
  ```

  종료 코드: `0` 정상, `1` 오류(업그레이드 중단), `2` 경고만(`--strict` 시 실패).
- [ ] **백업 경로** `deploy/backups/` (또는 `GDC_BACKUP_DIR`, **저장소 루트 하위**만 허용) 여유 디스크 확인.
- [ ] (선택) 호스트 `pg_dump` 경로: `scripts/ops/backup-postgres.sh`는 `DATABASE_URL` 기반 **custom format** 백업용(Compose 백업과 별개).

---

## 2. 업그레이드 실행 (Upgrade)

표준 경로: `scripts/release/upgrade.sh`

단계 요약(스크립트 내장):

1. 필수 백업 — `backup-before-upgrade.sh`
2. `docker compose build --pull`
3. `python -m app.db.validate_migrations --pre-upgrade` (컨테이너)
4. `alembic upgrade head` (일회성 `api` run)
5. `postgres` → `api` → (있으면) `reverse-proxy` 순 재기동 후 전체 `up -d --no-build`

체크:

- [ ] `GDC_RELEASE_COMPOSE_FILE`이 실제 스택과 일치하는지 확인한 뒤 `upgrade.sh` 실행(백업 단계에서 **실제 `pg_dump` 대상 DB 이름**이 로그에 기록됨).
- [ ] 업그레이드 로그: `deploy/backups/upgrade_<UTC>.log` 보관.
- [ ] `alembic current` 출력이 스크립트 끝에 기록되는지 확인(실패 시 로그에 원인).

**스테이징에서만 “드라이런”하는 방법**

- 동일 DB에서 전체 `upgrade.sh`를 돌리면 이미지 빌드·마이그레이션이 적용됩니다. **완전 비파괴 재현**이 필요하면 DB 복제본·별도 호스트에서 compose를 띄운 뒤 동일 절차를 수행합니다.
- 현재 런타임에 영향을 주지 않는 최소 검증: `validate-migrations.sh --pre-upgrade` + (가능 시) 별도 DB에 `alembic upgrade head` 시뮬레이션.

---

## 3. 업그레이드 직후 검증 (Post-upgrade)

- [ ] **API 프로세스 재시작 여부**  
  마이그레이션/`stamp` 직후 `migration_integrity` 등이 **기동 시점 스냅샷**일 수 있음 → 스크립트가 `api`를 올리지만, 수동으로 `alembic`을 돌렸다면 **`docker compose … restart api`** 한 번 더 권장 (`migration-integrity-validation.md` §4).
- [ ] **헬스**

  - 컨테이너: `docker compose … ps` (api / postgres / reverse-proxy healthy).
  - `GET /health` (비인증).

- [ ] **`migration_integrity`** (인증 필요)

  ```bash
  curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:${GDC_API_HOST_PORT:-8000}/api/v1/runtime/status"
  ```

  기대: HTTP 200, `migration_integrity.ok == true`, `alembic_revision`이 리포지토리 head와 일치.

- [ ] **관리자 유지보수 스냅샷**  
  `GET /api/v1/admin/maintenance/health` — `panels.migrations`, `overall` OK.
- [ ] **지원 번들** (운영 증빙·이관용)  
  `GET /api/v1/admin/support-bundle` — `docs/admin/support-bundle.md` 참고.
- [ ] (선택) **런타임/스타트업 로그**  
  `stage=startup_database_diagnostics` / `startup_readiness_summary` (`migration-recovery-runbook.md` § Startup diagnostics).

---

## 4. 롤백·복구 (Rollback / recovery)

**애플리케이션 롤백(이전 이미지/태그)**

- [ ] `docker compose -f <compose> down` (**`-v` 없이** — 볼륨 유지).
- [ ] 이전 Git 태그/이미지 digest로 checkout·빌드 후 `up -d`.
- [ ] DB를 이전 덤프로 되돌린 경우 **`validate-migrations.sh`** 통과 후 `alembic upgrade head` 여부는 **덤프 시점 스키마**에 따름 (`restore.sh` / 문서 참고).

**DB 복원 (파괴적)**

- [ ] `scripts/release/restore.sh` — `RESTORE_CONFIRM=YES_I_UNDERSTAND`, 덤프 경로, 프롬프트에 입력하는 DB 이름이 **복원 대상 카탈로그**와 일치하는지 재확인(기본값은 Compose `POSTGRES_DB`와 동일).
- [ ] 복원 후: `alembic upgrade head` 검토, `/health`, `migration_integrity`, 샘플 API.

**마이그레이션만 깨진 경우(고아 리비전 등)**

- [ ] `docs/operations/migration-recovery-runbook.md` 절차(백업 → SQL 검사 → 스키마 일치 시에만 `stamp` 검토 등).
- [ ] **stale snapshot**: DB `alembic_version`은 맞는데 API가 옛 오류를 보이면 **`api` 재시작** 후 재확인.

---

## 5. `migration_integrity` 전용 확인

- [ ] `python -m app.db.validate_migrations` / `./scripts/ops/validate-migrations.sh` (필요 시 `--json`, `--strict`).
- [ ] API: `runtime/status` + `admin/maintenance/health` 패널 일치.
- [ ] 고아 리비전 메시지가 있으면 업그레이드 진행 금지 → 런북.

---

## 6. 인증·세션 검증 (Auth)

- [ ] `REQUIRE_AUTH=true`(프로덕션)에서 로그인·리프레시·whoami 동작 (`auth-session-operations.md`).
- [ ] 비밀번호 변경/시드 리셋 후 **`token_version`** 으로 기존 JWT 무효화 여부 확인.
- [ ] (선택) Playwright: `operator-auth-runtime-smoke` (`migration-integrity-validation.md` §6).

---

## 7. Pytest DB 격리 검증 (호스트 CI/개발)

운영 릴리스 직후 필수는 아니나, **릴리스 검증 파이프라인**에 포함 권장.

- [ ] 호스트 `pytest`의 `TEST_DATABASE_URL`이 **`gdc_pytest`**(또는 정책상 허용된 테스트 카탈로그)인지 확인 — **`datarelay` / `gdc` 금지**(`tests/db_test_policy.py`, `docs/testing/backend-full-test.md`).
- [ ] 필요 시: `python3 scripts/test/ensure_gdc_pytest_catalog.py`.
- [ ] (선택) `bash scripts/test/run-backend-full.sh` 또는 CI와 동일한 job.

---

## 8. 릴리스 전 전수 사용자 테스트 — 필수

릴리스 후보는 아래 순서를 **동일 exact candidate HEAD**에서 모두 만족해야 합니다.

~~~text
exact-head machine qualification
→ Browser Feature Scenario Reconciliation
→ Full User E2E
→ owner/manual acceptance
→ release authorization/publication
~~~

- [ ] `docs/BROWSER_FEATURE_SCENARIO_RECONCILIATION.md` — ChatGPT Chat 직접 실행, PASS.
- [ ] `docs/FULL_USER_E2E_SCENARIOS.md` — ChatGPT Chat 직접 실행, PASS.
- [ ] 두 테스트 모두 required FAIL / PARTIAL / BLOCKED = 0.
- [ ] 실제 delivery와 장애/복구 증거 보존.
- [ ] destructive lifecycle / cleanup / zero-orphan PASS.
- [ ] unresolved P0 / P1 / user-blocking P2 = 0.
- [ ] 두 실행의 RUN_ID / evidence root / exact HEAD를 릴리스 결정에 기록.

Machine Full Regression 또는 operational E2E PASS는 위 두 전수 사용자 테스트를 대체하지 않습니다. CI/static contract 검증은 두 gate가 설정되어 있음을 확인할 뿐 실제 실행 PASS가 아닙니다. 실제 PASS 증거는 동일 exact candidate의 active release Work Packet과 evidence root에 남아 있어야 합니다.

두 전수 테스트 PASS 이후 관련 product/runtime/browser/harness/release contract가 변경되면 affected evidence는 무효화하고 동일 HEAD gate를 다시 성립시켜야 합니다.

---

## 9. 릴리스 차단 요인·잔여 리스크 (요약)

| 항목 | 내용 |
|------|------|
| **백업 대상 DB 불일치** | 과거에는 플랫폼 compose와 스크립트 기본값이 어긋날 수 있었으나, **현재는 compose에서 추론**합니다. 커스텀 compose에서는 `POSTGRES_DB`를 확인하고 필요 시 `GDC_BACKUP_DB_NAME`을 명시하세요. |
| **덤프 형식 혼동** | `release` 쪽은 **gzip SQL**; `scripts/ops/restore-postgres.sh`는 **custom `.dump`**. 서로 바꿔 쓰지 않음. |
| **`stamp` 오용** | 스키마 불일치 상태에서 `alembic stamp`는 데이터 손상 위험 — 런북·스키마 diff 선행. |
| **JWT 즉시 무효화 한계** | 액세스 토큰 TTL까지 일부 API는 구 토큰 허용 가능 — `auth-session-operations.md` “token_version 무효화가 적용되는 위치” 참고. |

---

## 10. 스크립트·도구 인덱스 (감사용)

| 경로 | 용도 |
|------|------|
| `scripts/release/install.sh` | 신규 설치(사전 마이그레이션 검사, `alembic upgrade head`, 시드, 전체 up). `--no-build`는 마이그레이션 생략. |
| `scripts/release/upgrade.sh` | 백업 → 빌드 → 사전 검증 → 마이그레이션 → 롤링식 재기동. `-v` 없음. |
| `scripts/release/backup-before-upgrade.sh` | Compose `postgres`에서 `pg_dump` → gzip. |
| `scripts/release/restore.sh` | gzip SQL 복원(DROP/CREATE DB). |
| `scripts/ops/validate-migrations.sh` | `validate_migrations` + Alembic heads 출력 래퍼. |
| `scripts/ops/backup-postgres.sh` / `restore-postgres.sh` | 호스트 `DATABASE_URL` 기준 custom dump 복원(사전 백업 내장). |
| `scripts/ops/validate-backup-restore-ops.sh` | 위 ops 스크립트 **비파괴** 스모크(문법·가드). |

---

*문서 버전: 저장소 상태 기준 2026-09-30 운영 감사 및 릴리스 전 전수 사용자 테스트 gate 반영.*
