import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TimestampUtcTransformGuide } from './timestamp-utc-transform-guide'

describe('TimestampUtcTransformGuide', () => {
  it('shows insertable Timestamp → UTC JSONata template for the selected field', () => {
    const onInsertExpression = vi.fn()

    render(
      <TimestampUtcTransformGuide
        mode="jsonata"
        variant="full_event"
        sampleEvent={{ creationTime: 1673933930200, username: 'admin@example.com' }}
        onInsertExpression={onInsertExpression}
      />,
    )

    expect(screen.getByTestId('timestamp-utc-transform-guide')).toHaveAttribute('data-mode', 'jsonata')
    expect(screen.getByText('Timestamp → UTC')).toBeInTheDocument()
    expect(screen.getByText(/insert or copy the JSONata template/i)).toBeInTheDocument()

    const source = screen.getByTestId('timestamp-utc-source-field') as HTMLSelectElement
    expect(source.value).toBe('$.creationTime')

    const preview = screen.getByTestId('timestamp-utc-template-preview')
    expect(preview.textContent).toContain('$fromMillis')
    expect(preview.textContent).toContain('creationTime')

    fireEvent.click(screen.getByTestId('timestamp-utc-insert-template'))
    expect(onInsertExpression).toHaveBeenCalledTimes(1)
    expect(onInsertExpression.mock.calls[0][0]).toContain('$merge')
    expect(onInsertExpression.mock.calls[0][0]).toContain('creationTime')
  })

  it('shows Regex limitation guidance and recommends JSONata', () => {
    render(
      <TimestampUtcTransformGuide
        mode="regex"
        variant="full_event"
        sampleEvent={{ timestamp: '2024-01-01T00:00:00Z' }}
      />,
    )

    expect(screen.getByTestId('timestamp-utc-transform-guide')).toHaveAttribute('data-mode', 'regex')
    expect(screen.getByText(/Regex cannot reliably compute or normalize timestamps/i)).toBeInTheDocument()
    expect(screen.getByText(/Use JSONata Timestamp → UTC instead/i)).toBeInTheDocument()
    expect(screen.queryByTestId('timestamp-utc-insert-template')).not.toBeInTheDocument()
  })
})
