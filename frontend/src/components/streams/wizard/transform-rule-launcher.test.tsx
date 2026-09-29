import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TransformRuleLauncher } from './transform-rule-launcher'

describe('TransformRuleLauncher', () => {
  it('presents task-oriented runtime-real transform choices', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<TransformRuleLauncher onSelect={onSelect} />)

    await user.click(screen.getByRole('button', { name: /Add transform/i }))

    expect(screen.getByRole('menu', { name: 'Add transform' })).toBeInTheDocument()
    expect(screen.getByText('Map / rename field')).toBeInTheDocument()
    expect(screen.getByText('Add fixed value')).toBeInTheDocument()
    expect(screen.getByText('Calculate field')).toBeInTheDocument()
    expect(screen.getByText('Normalize field')).toBeInTheDocument()
    expect(screen.getByText('Conditional field')).toBeInTheDocument()
    expect(screen.getByText('JSONata')).toBeInTheDocument()
    expect(screen.getByText('Regex')).toBeInTheDocument()
    expect(screen.queryByText(/^Lookup$/)).not.toBeInTheDocument()

    await user.click(screen.getByTestId('transform-launcher-normalize'))
    expect(onSelect).toHaveBeenCalledWith('normalize')
    expect(screen.queryByRole('menu', { name: 'Add transform' })).not.toBeInTheDocument()
  })

  it('closes on Escape without selecting an action', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<TransformRuleLauncher onSelect={onSelect} />)

    await user.click(screen.getByRole('button', { name: /Add transform/i }))
    expect(screen.getByRole('menu', { name: 'Add transform' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu', { name: 'Add transform' })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
