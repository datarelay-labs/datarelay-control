# shellcheck shell=bash
# Shared helpers for release scripts: infer the PostgreSQL catalog (POSTGRES_DB)
# for the Compose `postgres` service. Safe to `source` from other bash scripts.
#
# Resolution order for gdc_release_resolve_postgres_db_name:
#   1) If explicit_override is non-empty, use it (warn when it differs from compose).
#   2) Else POSTGRES_DB from `docker compose … config` (authoritative merged compose).
#   3) Else conservative path-based fallback (keeps behavior if `config` fails).

gdc_release_compose_postgres_field_from_config() {
  local root="$1" compose_rel="$2" field="$3" out
  out="$(
    (cd "$root" && docker compose -f "$compose_rel" config 2>/dev/null) | awk -v field="$field" '
      /^  postgres:$/ { pg=1; next }
      !pg { next }
      pg && $0 ~ "^      " field ":" {
        val=$0
        sub(/^      [^:]+:[[:space:]]*/, "", val)
        gsub(/^['\''"]|['\''"]$/, "", val)
        print val
        exit 0
      }
      pg && /^  [a-z0-9_-]+:$/ { exit 1 }
    '
  )"
  if [[ -n "${out//[[:space:]]/}" ]]; then
    printf '%s\n' "$out"
  fi
}

gdc_release_compose_postgres_db_from_config() {
  gdc_release_compose_postgres_field_from_config "$1" "$2" "POSTGRES_DB"
}

gdc_release_fallback_postgres_db_for_compose() {
  local compose_rel="$1"
  case "$compose_rel" in
    docker-compose.platform.yml | */docker-compose.platform.yml) printf '%s\n' "gdc" ;;
    deploy/docker-compose.https.yml | */deploy/docker-compose.https.yml) printf '%s\n' "gdc" ;;
    docker-compose.yml | */docker-compose.yml) printf '%s\n' "gdc" ;;
    *) printf '%s\n' "gdc" ;;
  esac
}

gdc_release_fallback_postgres_user_for_compose() {
  local compose_rel="$1"
  case "$compose_rel" in
    docker-compose.platform.yml | */docker-compose.platform.yml) printf '%s\n' "gdc" ;;
    deploy/docker-compose.https.yml | */deploy/docker-compose.https.yml) printf '%s\n' "gdc" ;;
    docker-compose.yml | */docker-compose.yml) printf '%s\n' "gdc" ;;
    *) printf '%s\n' "gdc" ;;
  esac
}

# Args: ROOT COMPOSE_REL
# Prints POSTGRES_USER for the Compose postgres service.
gdc_release_resolve_postgres_user() {
  local root="$1" compose_rel="$2"
  local from_config from_fb
  from_config="$(gdc_release_compose_postgres_field_from_config "$root" "$compose_rel" "POSTGRES_USER" || true)"
  from_fb="$(gdc_release_fallback_postgres_user_for_compose "$compose_rel")"
  printf '%s\n' "${from_config:-$from_fb}"
}

# Args: ROOT COMPOSE_REL [explicit_override]
# Prints the database name to use for backup/restore. Warnings on stderr when
# explicit_override disagrees with the compose-inferred catalog.
gdc_release_resolve_postgres_db_name() {
  local root="$1" compose_rel="$2" explicit="${3-}"
  local from_config from_fb inferred
  from_config="$(gdc_release_compose_postgres_db_from_config "$root" "$compose_rel" || true)"
  from_fb="$(gdc_release_fallback_postgres_db_for_compose "$compose_rel")"
  inferred="${from_config:-$from_fb}"
  if [[ -n "$explicit" ]]; then
    if [[ "$explicit" != "$inferred" ]]; then
      echo "WARN: explicit database name '$explicit' differs from compose-inferred POSTGRES_DB='$inferred' (compose file: $compose_rel)." >&2
      echo "      If this is unintentional, pg_dump/restore may target the wrong catalog." >&2
    fi
    printf '%s\n' "$explicit"
    return 0
  fi
  printf '%s\n' "$inferred"
}

# Args: ROOT COMPOSE_REL POSTGRES_USER POSTGRES_DB
#
# Probe the final PostgreSQL server over TCP and execute a real query against
# the target catalog. The official postgres image starts a temporary init
# server on the Unix socket only; pg_isready without -h can therefore report
# ready before POSTGRES_DB creation and before the final server restart.
gdc_release_postgres_catalog_usable() {
  local root="$1" compose_rel="$2" pg_user="$3" pg_db="$4"
  (
    cd "$root" || exit 1
    docker compose -f "$compose_rel" exec -T postgres sh -ec '
      export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
      exec psql -h 127.0.0.1 -U "$1" -d "$2" -v ON_ERROR_STOP=1 -Atqc "SELECT 1"
    ' sh "$pg_user" "$pg_db"
  ) >/dev/null 2>&1
}

# Args: ROOT COMPOSE_REL POSTGRES_USER POSTGRES_DB [attempts] [sleep_seconds]
gdc_release_wait_for_postgres_catalog() {
  local root="$1" compose_rel="$2" pg_user="$3" pg_db="$4"
  local attempts="${5:-45}" sleep_seconds="${6:-2}" attempt
  for attempt in $(seq 1 "$attempts"); do
    if gdc_release_postgres_catalog_usable "$root" "$compose_rel" "$pg_user" "$pg_db"; then
      return 0
    fi
    if [[ "$attempt" -lt "$attempts" ]]; then
      sleep "$sleep_seconds"
    fi
  done
  return 1
}
