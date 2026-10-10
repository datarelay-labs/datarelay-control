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
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('"user": "Alice"')

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
