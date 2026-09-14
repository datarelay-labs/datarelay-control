# 플랫폼 인증·세션 운영 가이드

JWT 기반 플랫폼 운영자 세션(스펙 020)의 동작, 무효화, 환경 변수, 관측 포인트를 정리합니다.

## 구성 요약

| 구성요소 | 설명 |
|----------|------|
| 로그인 | `POST /api/v1/auth/login` — 자격 증명 검증 후 액세스·리프레시 JWT 발급 |
| 액세스 토큰 | 짧은 TTL (`ACCESS_TOKEN_EXPIRE_MINUTES`, 기본 60). `Authorization: Bearer` |
| 리프레시 토큰 | 긴 TTL (`REFRESH_TOKEN_EXPIRE_MINUTES`, 기본 24h). `POST /api/v1/auth/refresh` 본문 |
| `token_version` | `platform_users.token_version` — 비밀번호 변경·강제 로그아웃·시드 비밀번호 리셋 시 증가 |
| `must_change_password` | 기본 `admin` 비밀번호 등에서 `true` — 대부분 API는 403 `PASSWORD_CHANGE_REQUIRED` |
| `REQUIRE_AUTH` | `true`이면 토큰 없는 요청은 401 `AUTH_REQUIRED`(바이패스 경로 제외) |

## 주요 HTTP 엔드포인트

- **`POST /api/v1/auth/login`** — 성공 시 `USER_LOGIN` 감사 이벤트, `last_login_at` 갱신.
- **`POST /api/v1/auth/refresh`** — 리프레시 JWT 검증 후 새 액세스+리프레시 쌍(회전). DB `token_version` 불일치 시 401 `AUTH_TOKEN_REVOKED`.
- **`GET /api/v1/auth/whoami`** — 액세스 JWT + DB `token_version` 교차 검증. SPA 부트 시 세션 유효성 확인에 사용.
- **`POST /api/v1/auth/logout`** — 본문 `{"revoke_all": true}` 시 `token_version` 증가(다른 세션 무효화). 유효한 Bearer 없어도 204(멱등).
- **`POST /api/v1/auth/change-password`** — 현재 비밀번호 확인 후 정책 검사, 성공 시 `token_version` 증가(기존 JWT 전부 재발급 필요).

`REQUIRE_AUTH=false`(개발/일부 테스트)에서는 토큰이 없으면 익명 `ADMINISTRATOR`로 처리됩니다. 프로덕션에서는 `REQUIRE_AUTH=true`를 유지하세요.

## `token_version` 무효화가 적용되는 위치

다음에서는 **DB의 현재 `token_version`과 JWT 클레임 `tv`가 반드시 일치**해야 합니다.

- `POST /api/v1/auth/refresh`
- `GET /api/v1/auth/whoami`
- `POST /api/v1/auth/change-password`

그 외 대부분의 API 미들웨어는 서명·만료·역할만 검사합니다. 즉, **`token_version`이 올라간 뒤에도 액세스 토큰이 만료되기 전까지는 일반 API 호출이 통과할 수 있습니다.** 운영상 리스크는 `ACCESS_TOKEN_EXPIRE_MINUTES`로 상한이 있습니다. 전 구간에서 즉시 무효화가 필요하면(추가 DB 조회) 별도 설계가 필요합니다.

### Contract note (vs `specs/020-jwt-session-auth`)

**INTENTIONAL_BY_CONTRACT:** Live `token_version` is checked on refresh / whoami / change-password only. Global `role_guard` middleware validates signature, expiry, issuer, and role — it does **not** re-read `platform_users.token_version` on every request. Spec 020 wording that the role guard rejects stale `tv` against the current user row is aspirational / outdated relative to this ops contract; do not treat middleware live-TV invalidation as implemented unless product docs change.

시드/운영 절차에서 `admin` 비밀번호를 리셋하면(`app.db.seed.reset_or_create_platform_admin_password` 등) `token_version`이 올라가므로, 기존 브라우저 세션은 **다음 `whoami` 또는 리프레시 시점**에 거부됩니다.

## `must_change_password`와 미들웨어

JWT에 `mcp` 클레임이 있으면 `must_change_password`로 간주됩니다. `REQUIRE_AUTH=true`일 때 다음 **외**의 경로는 403 `PASSWORD_CHANGE_REQUIRED`입니다.

- `/api/v1/auth/refresh`, `/logout`, `/whoami`, `/change-password`

비밀번호 변경 완료 후에는 새 로그인으로 발급된 토큰으로 일반 API를 사용합니다.

## 환경 변수

| 변수 | 용도 |
|------|------|
| `REQUIRE_AUTH` | 프로덕션에서 `true` 권장 |
| `JWT_SECRET_KEY` / `SECRET_KEY` | HS256 서명 키(프로덕션에서 강한 값 필수) |
| `JWT_ISSUER` | 발급자 클레임 |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | 액세스 TTL |
| `REFRESH_TOKEN_EXPIRE_MINUTES` | 리프레시 TTL |
| `AUTH_DEV_HEADER_TRUST` | `X-GDC-Role` 신뢰(기본 `false`; 프로덕션에서 `false` 유지) |
| `GDC_SEED_ADMIN_PASSWORD` | 시드 시 `admin` 비밀번호; 기존 행 리셋 시 `token_version` 증가 |

## 감사·로깅

로그인, 리프레시, 로그아웃, 자가 비밀번호 변경은 `platform_audit_events`에 기록됩니다(액션 예: `USER_LOGIN`, `USER_TOKEN_REFRESHED`, `USER_LOGOUT`, `PASSWORD_CHANGED`). 운영자는 Admin 감사 로그 UI 또는 `GET /api/v1/admin/audit-log`로 조회합니다.

## 프런트엔드 세션

- 저장소: `localStorage` 키 `gdc_platform_session_v1`(액세스·리프레시·`expires_at`·사용자 요약).
- `401`: `requestJson` 등이 한 번 `POST /auth/refresh`를 시도하고, 실패 시 세션 삭제 후 로그인 화면으로 이동합니다.
- 부트 시: 유효한 세션이 있으면 `GET /auth/whoami`로 서버와 동기화하여, 폐기된 토큰을 즉시 정리합니다.

## 수동 검증 예시

로컬 API가 `http://127.0.0.1:8000`일 때:

```bash
# 로그인
curl -sS -X POST http://127.0.0.1:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' | jq .

# 액세스 토큰을 환경에 넣은 뒤
export TOKEN='...access_token...'

curl -sS http://127.0.0.1:8000/api/v1/auth/whoami \
  -H "Authorization: Bearer $TOKEN" | jq .

curl -sS -X POST http://127.0.0.1:8000/api/v1/auth/logout \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"revoke_all":true}' -i
```

## 관련 테스트

`tests/test_jwt_session_auth.py` — 로그인, `whoami`, 리프레시, `revoke_all` 로그아웃, 비밀번호 변경 후 토큰 무효화, `REQUIRE_AUTH` 동작 등.

## 잔여 운영 리스크(요약)

- 액세스 토큰 TTL 동안은 **미들웨어가 DB `token_version`을 매 요청 검사하지 않음**(위 표 참고).
- 리프레시 토큰은 서버 측 저장소 없이 JWT 자체이므로, TTL이 남아 있으면 서명이 맞고 `token_version`이 맞는 한 유효합니다.
- 테스트 DB **`gdc`**는 실행 중인 Docker API·검증 랩과 공유됩니다. 호스트에서 **`pytest`를 돌릴 때는 `gdc_pytest` 등 전용 카탈로그**를 쓰세요(`tests/conftest.py`가 `gdc`에 대한 TRUNCATE·스키마 리셋을 거부합니다). `gdc`에 로컬 앱과 pytest가 동시에 붙으면 락·세션 경합이 날 수 있습니다.
