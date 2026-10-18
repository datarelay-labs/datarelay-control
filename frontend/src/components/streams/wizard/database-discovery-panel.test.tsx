import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseDiscoveryPanel } from './database-discovery-panel'

const { runDatabaseDiscoveryMock } = vi.hoisted(() => ({
  runDatabaseDiscoveryMock: vi.fn(),
}))

vi.mock('../../../api/gdcRuntimePreview', () => ({
  runDatabaseDiscovery: runDatabaseDiscoveryMock,
}))

function renderPanel(
  props: Partial<ComponentProps<typeof DatabaseDiscoveryPanel>> = {},
) {
  const onApplySelection = props.onApplySelection ?? vi.fn()
  return {
    onApplySelection,
    ...render(
      <DatabaseDiscoveryPanel
        connectorId={props.connectorId ?? 17}
        connectorName={props.connectorName ?? 'Saved PostgreSQL'}
        sqlQuery={props.sqlQuery ?? ''}
        queryParams={props.queryParams ?? {}}
        checkpointColumn={props.checkpointColumn ?? ''}
        onApplySelection={onApplySelection}
      />,
    ),
  }
}

describe('DatabaseDiscoveryPanel', () => {
  beforeEach(() => {
    runDatabaseDiscoveryMock.mockReset()
  })

  it('renders real returned schemas, relations and column types without inventing metadata', async () => {
    runDatabaseDiscoveryMock.mockResolvedValue({
      ok: true,
      db_type: 'POSTGRESQL',
      database: 'gdc_query_fixture',
      schemas: ['audit', 'public'],
      tables: [
        {
          schema_name: 'public',
          table_name: 'source_e2e_rows',
          table_type: 'BASE TABLE',
          columns: [
            { name: 'id', data_type: 'integer', nullable: false, ordinal_position: 1 },
            { name: 'event_ts', data_type: 'timestamp with time zone', nullable: false, ordinal_position: 2 },
          ],
        },
        {
          schema_name: 'audit',
          table_name: 'history',
          table_type: 'VIEW',
          columns: [{ name: 'event_id', data_type: 'text', nullable: true, ordinal_position: 1 }],
        },
      ],
      truncated: false,
      message: 'Discovered 2 relation(s) and 3 column(s).',
    })

    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Discover database' }))

    await waitFor(() => expect(runDatabaseDiscoveryMock).toHaveBeenCalledWith(17))
    expect(await screen.findByText('public.source_e2e_rows')).toBeInTheDocument()
    expect(screen.getByText(/event_ts/)).toBeInTheDocument()
    expect(screen.getByText(/timestamp with time zone/)).toBeInTheDocument()
    expect(screen.queryByText('audit.history')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('wizard-database-discovery-schema'), { target: { value: 'audit' } })
    expect(screen.getByText('audit.history')).toBeInTheDocument()
    expect(screen.queryByText('public.source_e2e_rows')).not.toBeInTheDocument()
  })

  it('builds a quoted SELECT with bound filter values and incremental checkpoint from discovered metadata', async () => {
    runDatabaseDiscoveryMock.mockResolvedValue({
      ok: true,
      db_type: 'POSTGRESQL',
      database: 'gdc_query_fixture',
      schemas: ['public'],
      tables: [{
        schema_name: 'public',
        table_name: 'security_events',
        table_type: 'BASE TABLE',
        columns: [
          { name: 'id', data_type: 'integer', nullable: false, ordinal_position: 1 },
          { name: 'message', data_type: 'text', nullable: true, ordinal_position: 2 },
        ],
      }],
      truncated: false,
      message: 'ok',
    })
    const onApplySelection = vi.fn()
    renderPanel({ onApplySelection })

    fireEvent.click(screen.getByRole('button', { name: 'Discover database' }))
    await screen.findByText('public.security_events')
    fireEvent.click(screen.getByTestId('wizard-database-use-table-public-security_events'))
    fireEvent.change(screen.getByLabelText('Filter column'), { target: { value: 'message' } })
    fireEvent.change(screen.getByTestId('wizard-database-filter-value'), { target: { value: "x' OR 1=1 --" } })
    fireEvent.change(screen.getByTestId('wizard-database-sync-mode'), { target: { value: 'incremental' } })
    fireEvent.change(screen.getByTestId('wizard-database-builder-checkpoint'), { target: { value: 'id' } })
    fireEvent.click(screen.getByTestId('wizard-database-apply-selection'))

    expect(onApplySelection).toHaveBeenCalledWith({
      sqlQuery: 'SELECT "id", "message" FROM "public"."security_events" WHERE "message" = %(ui_filter_1)s',
      dbQueryParams: { ui_filter_1: "x' OR 1=1 --" },
      dbCheckpointColumn: 'id',
      dbCheckpointMode: 'SINGLE_COLUMN',
    })
  })

  it('shows a discovery failure instead of presenting an empty database as success', async () => {
    runDatabaseDiscoveryMock.mockRejectedValue(new Error('PostgreSQL discovery connection failed: timeout'))

    renderPanel({ connectorId: 18, connectorName: 'Broken PostgreSQL' })
    fireEvent.click(screen.getByRole('button', { name: 'Discover database' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('PostgreSQL discovery connection failed: timeout')
    expect(screen.queryByTestId('wizard-database-discovery-relations')).not.toBeInTheDocument()
  })

  it('clears previously discovered metadata when the saved Connector changes', async () => {
    runDatabaseDiscoveryMock.mockResolvedValue({
      ok: true,
      db_type: 'POSTGRESQL',
      database: 'first',
      schemas: ['public'],
      tables: [{
        schema_name: 'public',
        table_name: 'first_table',
        table_type: 'BASE TABLE',
        columns: [{ name: 'id', data_type: 'integer', nullable: false, ordinal_position: 1 }],
      }],
      truncated: false,
      message: 'ok',
    })

    const onApplySelection = vi.fn()
    const { rerender } = renderPanel({ connectorId: 17, connectorName: 'First', onApplySelection })
    fireEvent.click(screen.getByRole('button', { name: 'Discover database' }))
    expect(await screen.findByText('public.first_table')).toBeInTheDocument()

    rerender(
      <DatabaseDiscoveryPanel
        connectorId={19}
        connectorName="Second"
        sqlQuery=""
        queryParams={{}}
        checkpointColumn=""
        onApplySelection={onApplySelection}
      />,
    )
    expect(screen.queryByText('public.first_table')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discover database' })).toBeInTheDocument()
  })
})
