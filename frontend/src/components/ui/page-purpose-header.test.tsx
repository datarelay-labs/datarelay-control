import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { PagePurposeHeader } from './page-purpose-header'

describe('PagePurposeHeader', () => {
  const help = {
    title: 'Governance Dashboard',
    intro: 'Use this page to understand governance posture and decide what needs attention.',
    sections: [
      {
        title: 'What to look at first',
        bullets: ['Overall posture', 'Highest-priority next action'],
      },
      {
        title: 'Where configuration happens',
        body: 'Configure governance from the owning Stream or Route context.',
      },
    ],
  } as const

  it('renders purpose and opens contextual help without leaving the page', async () => {
    const user = userEvent.setup()
    render(
      <PagePurposeHeader
        title="Governance Dashboard"
        purpose="See what needs attention and where to investigate."
        help={help}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Governance Dashboard', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/what needs attention/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Help' }))
    expect(screen.getByRole('dialog', { name: 'Governance Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('Where configuration happens')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close help' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('traps keyboard focus inside the modal help drawer', async () => {
    const user = userEvent.setup()
    render(
      <PagePurposeHeader
        title="Governance Dashboard"
        purpose="See what needs attention and where to investigate."
        help={{ ...help, docsHref: 'https://example.com/docs/governance' }}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Help' }))
    const close = screen.getByRole('button', { name: 'Close help' })
    const docs = screen.getByRole('link', { name: /read full documentation/i })
    expect(close).toHaveFocus()

    await user.tab({ shift: true })
    expect(docs).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
  })

  it('links to in-product operator guide while preserving the current editing page', async () => {
    const user = userEvent.setup()
    render(<PagePurposeHeader title="Destinations" purpose="Choose a delivery target" help={{
      ...help,
      docsHref: '/help/delivery',
    }} />)
    await user.click(screen.getByRole('button', { name: 'Help' }))
    const link = screen.getByRole('link', { name: 'Open step-by-step guide' })
    expect(link).toHaveAttribute('href', '/help/delivery')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('closes the drawer with Escape', async () => {
    const user = userEvent.setup()
    render(
      <PagePurposeHeader
        title="Governance Dashboard"
        purpose="See what needs attention and where to investigate."
        help={help}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Help' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
