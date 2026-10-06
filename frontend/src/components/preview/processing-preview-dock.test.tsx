import { render, screen } from '@testing-library/react'
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
})
