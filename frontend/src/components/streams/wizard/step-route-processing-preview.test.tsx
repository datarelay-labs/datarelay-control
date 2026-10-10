import { useEffect } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { FinalEventDraftPreviewResponse } from '../../../api/gdcRuntimePreview'
import { StepRouteProcessing } from './step-route-processing'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'

vi.mock('../../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [
    { id: 10, name: 'Splunk Endpoint', destination_type: 'SYSLOG_UDP' },
  ]),
}))

const verifiedDraftPreview: FinalEventDraftPreviewResponse = {
  input_event_count: 1,
  preview_event_count: 1,
  mapped_events: [{ normalized: 'evt-1' }],
  final_events: [{ normalized: 'evt-1', vendor: 'sample' }],
  missing_fields: [],
  message: 'Mapping and enrichment preview generated',
}

vi.mock('./wizard-mapping-output-aside', () => ({
  WizardMappingOutputAside: (props: {
    previewScope?: string
    onPreviewEvidence?: (scope: string, evidence: FinalEventDraftPreviewResponse | null) => void
  }) => {
    const { previewScope, onPreviewEvidence } = props
    useEffect(() => {
      if (previewScope) onPreviewEvidence?.(previewScope, verifiedDraftPreview)
    }, [previewScope, onPreviewEvidence])
    return <aside data-testid="test-mapping-output-aside">Existing final-event preview</aside>
  },
}))

describe('Route Processing preview uses the existing final-event API evidence', () => {
  it('shows mapped and enriched outputs without claiming Route Policy or delivery enforcement', async () => {
    const state = buildInitialState()
    state.stream.useWholeResponseAsEvent = true
    state.apiTest.status = 'success'
    state.apiTest.parsedJson = { id: 'evt-1' }
    state.apiTest.extractedEvents = [{ id: 'evt-1' }]
    state.destinations.routeDrafts = [{
      key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE',
      rateLimitJson: {}, inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    }]
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByTestId('processing-preview-stage-mapping'))
    await waitFor(() => {
      expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('"normalized": "evt-1"')
    })
    fireEvent.click(screen.getByTestId('processing-preview-stage-transform'))
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('"vendor": "sample"')
    fireEvent.click(screen.getByTestId('processing-preview-stage-policy'))
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('No after-preview for this stage')
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('not Route Protection or Policy proof')
  })
})
