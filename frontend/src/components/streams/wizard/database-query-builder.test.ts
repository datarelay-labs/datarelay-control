import { describe, expect, it } from 'vitest'
import {
  buildDatabaseSelectionQuery,
  parseDatabaseSelectionQuery,
  quotePostgresIdentifier,
} from './database-query-builder'

describe('database query builder', () => {
  it('quotes discovered identifiers and binds filter values instead of interpolating them', () => {
    const built = buildDatabaseSelectionQuery({
      schemaName: 'audit data',
      tableName: 'events"2026',
      columns: ['event id', 'message'],
      filterColumn: 'message',
      filterOperator: '=',
      filterValue: "x' OR 1=1 --",
      syncMode: 'incremental',
      checkpointColumn: 'event id',
    })

    expect(built.sqlQuery).toBe(
      'SELECT "event id", "message" FROM "audit data"."events""2026" WHERE "message" = %(ui_filter_1)s',
    )
    expect(built.sqlQuery).not.toContain("x' OR 1=1")
    expect(built.queryParams).toEqual({ ui_filter_1: "x' OR 1=1 --" })
    expect(built.dbCheckpointColumn).toBe('event id')
    expect(built.dbCheckpointMode).toBe('SINGLE_COLUMN')
  })

  it('round-trips the representable generated SELECT back to builder selections', () => {
    const built = buildDatabaseSelectionQuery({
      schemaName: 'public',
      tableName: 'security_events',
      columns: ['id', 'event_type'],
      filterColumn: 'event_type',
      filterOperator: 'LIKE',
      filterValue: 'auth%',
      syncMode: 'full',
    })

    expect(parseDatabaseSelectionQuery(built.sqlQuery, built.queryParams, built.dbCheckpointColumn)).toMatchObject({
      schemaName: 'public',
      tableName: 'security_events',
      columns: ['id', 'event_type'],
      filterColumn: 'event_type',
      filterOperator: 'LIKE',
      filterValue: 'auth%',
      syncMode: 'full',
    })
  })

  it('does not pretend advanced SQL is representable by the basic builder', () => {
    expect(
      parseDatabaseSelectionQuery(
        'SELECT e.id FROM public.events e JOIN public.users u ON u.id = e.user_id',
        {},
        '',
      ),
    ).toBeNull()
  })

  it('quotes embedded double quotes deterministically', () => {
    expect(quotePostgresIdentifier('a"b')).toBe('"a""b"')
  })

  it('requires a checkpoint column for incremental sync', () => {
    expect(() =>
      buildDatabaseSelectionQuery({
        schemaName: 'public',
        tableName: 'events',
        columns: ['id'],
        syncMode: 'incremental',
      }),
    ).toThrow(/checkpoint column/i)
  })
})
