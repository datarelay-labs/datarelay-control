"""Read-only PostgreSQL schema/table/column discovery for DATABASE_QUERY onboarding."""

from __future__ import annotations

from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

from app.runtime.errors import SourceFetchError
from app.sources.database_query.execute import _ssl_mode_pg

MAX_DISCOVERY_SCHEMAS = 50
MAX_DISCOVERY_TABLES = 100
MAX_COLUMNS_PER_TABLE = 100

_EXCLUDED_SCHEMAS = ("pg_catalog", "information_schema")


def _required_connection_config(source_config: dict[str, Any]) -> tuple[str, int, str, str, str, str, int]:
    db_type = str(source_config.get("db_type") or "").strip().upper()
    if db_type != "POSTGRESQL":
        raise SourceFetchError("database discovery supports POSTGRESQL only")

    host = str(source_config.get("host") or "").strip()
    port = int(source_config.get("port") or 5432)
    database = str(source_config.get("database") or "").strip()
    user = str(source_config.get("username") or "").strip()
    password = str(source_config.get("password") or "")
    ssl_mode = str(source_config.get("ssl_mode") or "PREFER")
    connect_timeout = max(1, min(int(source_config.get("connection_timeout_seconds") or 15), 60))
    if not host or not database or not user:
        raise SourceFetchError("host, database, and username are required for database discovery")
    if port <= 0:
        raise SourceFetchError("port must be a positive integer")
    return host, port, database, user, password, ssl_mode, connect_timeout


def discover_postgres_catalog(source_config: dict[str, Any]) -> dict[str, Any]:
    """Return bounded metadata visible to the saved PostgreSQL user."""

    host, port, database, user, password, ssl_mode, connect_timeout = _required_connection_config(
        dict(source_config or {})
    )
    conn = None
    try:
        conn = psycopg2.connect(
            host=host,
            port=port,
            dbname=database,
            user=user,
            password=password,
            connect_timeout=connect_timeout,
            sslmode=_ssl_mode_pg(ssl_mode),
            options="-c statement_timeout=5000 -c default_transaction_read_only=on",
        )
        conn.set_session(readonly=True, autocommit=True)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT schema_name
                FROM information_schema.schemata
                WHERE schema_name <> ALL(%s)
                  AND schema_name NOT LIKE 'pg_%%'
                ORDER BY schema_name
                LIMIT %s
                """,
                (list(_EXCLUDED_SCHEMAS), MAX_DISCOVERY_SCHEMAS + 1),
            )
            schema_rows = [dict(row) for row in cur.fetchall()]
            schemas_truncated = len(schema_rows) > MAX_DISCOVERY_SCHEMAS
            schema_names = [str(row["schema_name"]) for row in schema_rows[:MAX_DISCOVERY_SCHEMAS]]

            cur.execute(
                """
                SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_schema <> ALL(%s)
                  AND table_schema NOT LIKE 'pg_%%'
                  AND table_type IN ('BASE TABLE', 'VIEW')
                ORDER BY table_schema, table_name
                LIMIT %s
                """,
                (list(_EXCLUDED_SCHEMAS), MAX_DISCOVERY_TABLES + 1),
            )
            table_rows = [dict(row) for row in cur.fetchall()]
            tables_truncated = len(table_rows) > MAX_DISCOVERY_TABLES
            table_rows = table_rows[:MAX_DISCOVERY_TABLES]

            tables: list[dict[str, Any]] = []
            columns_truncated = False
            for table in table_rows:
                schema_name = str(table["table_schema"])
                table_name = str(table["table_name"])
                cur.execute(
                    """
                    SELECT column_name, data_type, is_nullable, ordinal_position
                    FROM information_schema.columns
                    WHERE table_schema = %s AND table_name = %s
                    ORDER BY ordinal_position
                    LIMIT %s
                    """,
                    (schema_name, table_name, MAX_COLUMNS_PER_TABLE + 1),
                )
                column_rows = [dict(row) for row in cur.fetchall()]
                if len(column_rows) > MAX_COLUMNS_PER_TABLE:
                    columns_truncated = True
                columns = [
                    {
                        "name": str(row["column_name"]),
                        "data_type": str(row["data_type"]),
                        "nullable": str(row["is_nullable"]).upper() == "YES",
                        "ordinal_position": int(row["ordinal_position"]),
                    }
                    for row in column_rows[:MAX_COLUMNS_PER_TABLE]
                ]
                tables.append(
                    {
                        "schema_name": schema_name,
                        "table_name": table_name,
                        "table_type": str(table["table_type"]),
                        "columns": columns,
                    }
                )
    except SourceFetchError:
        raise
    except Exception as exc:
        if conn is None:
            raise SourceFetchError(f"PostgreSQL discovery connection failed: {exc}") from exc
        raise SourceFetchError(f"PostgreSQL metadata discovery failed: {exc}") from exc
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    return {
        "db_type": "POSTGRESQL",
        "database": database,
        "schemas": schema_names,
        "tables": tables,
        "truncated": bool(schemas_truncated or tables_truncated or columns_truncated),
    }
