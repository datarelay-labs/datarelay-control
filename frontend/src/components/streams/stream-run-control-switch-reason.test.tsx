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

describe('StreamRunControlSwitch stopping state (F-176)', () => {
  it('reads Stopping, is not active and cannot be toggled until the stop is confirmed', () => {
    const onToggle = vi.fn()
    render(<StreamRunControlSwitch status="STOPPED" stopping onToggle={onToggle} />)
    const button = screen.getByRole('switch')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-checked', 'false')
    expect(button).toHaveAttribute('aria-label', 'Stream scheduler: Stopping')
    expect(button).toHaveAttribute('title', expect.stringContaining('still stopping'))
    expect(screen.getByText('Stopping…')).toBeInTheDocument()
    button.click()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('offers Start again once the stop is confirmed', () => {
    render(<StreamRunControlSwitch status="STOPPED" onToggle={vi.fn()} />)
    expect(screen.getByRole('switch')).toBeEnabled()
    expect(screen.getByText('Start')).toBeInTheDocument()
  })
})
