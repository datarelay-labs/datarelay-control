import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProcessingPreviewDock } from './processing-preview-dock'

describe('ProcessingPreviewDock', () => {
  it('keeps preview, saved configuration, and runtime truth explicit', () => {
    render(<ProcessingPreviewDock stages={[
      { id: 'input', label: 'Input', truth: 'Preview', before: { a: 1 }, after: { a: 1 } },
      { id: 'mapping', label: 'Mapping', truth: 'Saved configuration' },
      { id: 'runtime', label: 'Runtime', truth: 'Runtime' },
    ]} />)
    expect(screen.getByTestId('processing-preview-dock')).toHaveTextContent('Preview evidence never claims persistence or delivery success')
    expect(screen.getByTestId('processing-preview-stage-mapping')).toHaveTextContent('Saved configuration')
    expect(screen.getByTestId('processing-preview-stage-runtime')).toHaveTextContent('Runtime')
  })

  it('focuses one processing stage and does not present missing data as a successful preview', () => {
    render(<ProcessingPreviewDock stages={[
      { id: 'input', label: 'Input', truth: 'Preview', before: { user: 'Alice' }, after: { user: 'Alice' } },
      { id: 'mapping', label: 'Mapping', truth: 'Preview', status: 'Draft', before: { user: 'Alice' },
        message: 'Open the Final event workspace to preview mapping.' },
    ]} />)

    const inputTab = screen.getByTestId('processing-preview-stage-input')
    const mappingTab = screen.getByTestId('processing-preview-stage-mapping')
    expect(inputTab).toHaveAttribute('aria-pressed', 'true')
    expect(mappingTab).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('table', { name: 'Input field comparison' })).toHaveTextContent('$.user')
    expect(screen.getByRole('table', { name: 'Input field comparison' })).toHaveTextContent('Alice')

    fireEvent.click(mappingTab)
    expect(mappingTab).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('No after-preview for this stage')
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('Open the Final event workspace')
    expect(screen.getByTestId('processing-preview-stage-comparison')).not.toHaveTextContent('Delivery proven')
  })

  it('does not fabricate a comparison for a stage without data', () => {
    render(<ProcessingPreviewDock stages={[
      { id: 'policy', label: 'Protection / Policy', truth: 'Preview', status: 'Not yet evaluated' },
    ]} />)
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent(
      'No before/after evidence for this stage yet',
    )
    expect(screen.queryByText('null')).not.toBeInTheDocument()
  })
})

// M3-01/M3-07: the existing dock owns comparison; no parallel preview engine.
describe('field-first result inspection', () => {
  it('shows the four result states and makes JSON a secondary view', () => {
    render(<ProcessingPreviewDock stages={[
      { id: 'transform', label: 'Transform', truth: 'Preview',
        before: { changed: 1, removed: true, keep: null }, after: { changed: 2, added: true, keep: null } },
    ]} />)
    const table = screen.getByRole('table', { name: 'Transform field comparison' })
    expect(table).toHaveTextContent('Added')
    expect(table).toHaveTextContent('Changed')
    expect(table).toHaveTextContent('Removed')
    expect(table).toHaveTextContent('Unchanged')
    expect(screen.getByRole('button', { name: 'Field changes' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Changes only' }))
    expect(table).not.toHaveTextContent('$.keep')
    fireEvent.click(screen.getByRole('button', { name: 'JSON detail' }))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('"changed": 2')
  })

  it('does not compare missing output with an empty event', () => {
    render(<ProcessingPreviewDock stages={[
      { id: 'policy', label: 'Policy', truth: 'Preview', before: { email: 'synthetic@example.test' }, after: null },
    ]} />)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText('No after-preview for this stage')).toBeInTheDocument()
    expect(screen.queryByText('Removed')).not.toBeInTheDocument()
  })

  it('labels a limited comparison without asserting there are no changes outside it', () => {
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`field${i}`, i]))
    render(<ProcessingPreviewDock stages={[{ id: 'sample', label: 'Sample', truth: 'Preview', before: many, after: many }]} />)
    expect(screen.getByRole('status')).toHaveTextContent('Comparison limited')
    expect(screen.getByRole('status')).toHaveTextContent('200')
  })
})
