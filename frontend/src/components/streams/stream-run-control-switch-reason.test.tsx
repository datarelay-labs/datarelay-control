import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StreamRunControlSwitch } from './stream-run-control-switch'

describe('StreamRunControlSwitch disabled reason (F-150)', () => {
  it('explains why Start is disabled instead of the generic tooltip', () => {
    render(
      <StreamRunControlSwitch
        status="STOPPED"
        disabled
        disabledReason="Start is unavailable because the last save failed or was only partly applied."
        onToggle={vi.fn()}
      />,
    )
    const button = screen.getByRole('switch')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('last save failed'))
  })

  it('keeps the normal tooltip when enabled', () => {
    render(<StreamRunControlSwitch status="STOPPED" disabledReason="ignored while enabled" onToggle={vi.fn()} />)
    expect(screen.getByRole('switch')).toHaveAttribute('title', 'Turn on the scheduled polling worker for this stream.')
  })
})
