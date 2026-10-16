import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SavedRouteProcessingPreview } from './saved-route-processing-preview'
import { runRouteE2EDraftPreview, type RouteE2EDraftPreviewResponse } from '../../api/gdcRuntimePreview'

vi.mock('../../api/gdcRuntimePreview', () => ({ runRouteE2EDraftPreview: vi.fn() }))
const preview = vi.mocked(runRouteE2EDraftPreview)
const sample = [{ email: 'synthetic@example.test', id: 1 }]
const props = { routeId: 7, streamId: 4, events: sample, revision: 'saved-1', ready: true, dirty: false }
function response(routeId = 7): RouteE2EDraftPreviewResponse {
  return {
    route_id: routeId, stream_id: 4, destination_id: 9, destination_type: 'SYSLOG_UDP', configuration_state: 'saved',
    mapped_events: sample, final_events: [{ email: 's***@example.test', id: 1 }],
    preview_messages: ['<134> synthetic syslog message'], display_redacted: false,
    stage_previews: { input: sample, mapping: sample, transform: sample,
      protection: [{ email: 's***@example.test', id: 1 }], classification: [{ classification_level: 'INTERNAL' }],
      policy: [{ email: 's***@example.test', id: 1 }], destination: ['<134> synthetic syslog message'] },
    route_stage_timeline: [{ stage: 'policy', decision: 'allow', decision_reason: 'No matching block rule' }],
    delivery_allowed: true, policy_action: 'allow', message: 'No events were sent.',
  }
}
beforeEach(() => { vi.resetAllMocks(); preview.mockResolvedValue(response()) })

describe('M3 saved Route actual processing preview', () => {
  it('uses extracted samples once and shows real protection and saved destination output', async () => {
    render(<SavedRouteProcessingPreview {...props} />)
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1))
    expect(preview).toHaveBeenCalledWith({ route_id: 7, stream_id: 4, payload: sample, field_mappings: {}, enrichment: {}, max_events: 3 })
    await screen.findByText('SYSLOG_UDP · Destination #9')
    fireEvent.click(screen.getByTestId('processing-preview-stage-protection'))
    expect(screen.getByRole('table', { name: 'Data Protection field comparison' })).toHaveTextContent('s***@example.test')
    fireEvent.click(screen.getByTestId('processing-preview-stage-destination'))
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('<134> synthetic syslog message')
    expect(screen.getByTestId('saved-route-processing-preview')).toHaveTextContent('No events sent')
    expect(screen.getByTestId('processing-preview-stage-classification')).toBeInTheDocument()
  })
  it('rejects a response for a different Route or Stream', async () => {
    preview.mockResolvedValue(response(8))
    render(<SavedRouteProcessingPreview {...props} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('does not match')
    expect(screen.queryByText('SYSLOG_UDP · Destination #9')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
  it('does not show saved output as evidence for an unsaved draft', async () => {
    const view = render(<SavedRouteProcessingPreview {...props} />)
    await screen.findByText('SYSLOG_UDP · Destination #9')
    view.rerender(<SavedRouteProcessingPreview {...props} dirty />)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByTestId('saved-route-processing-preview')).toHaveTextContent('Save Transform to preview the complete Route')
    expect(preview).toHaveBeenCalledTimes(1)
  })
  it('ignores a late response after switching Routes', async () => {
    let resolveOld!: (value: RouteE2EDraftPreviewResponse) => void
    preview.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve })).mockResolvedValueOnce(response(8))
    const view = render(<SavedRouteProcessingPreview {...props} />)
    view.rerender(<SavedRouteProcessingPreview {...props} routeId={8} />)
    await screen.findByText('SYSLOG_UDP · Destination #9')
    await act(async () => resolveOld({ ...response(), destination_type: 'WEBHOOK_POST', destination_id: 777 }))
    expect(screen.queryByText('WEBHOOK_POST · Destination #777')).not.toBeInTheDocument()
  })
  it('clears previous output when a retry fails', async () => {
    const view = render(<SavedRouteProcessingPreview {...props} />)
    await screen.findByText('SYSLOG_UDP · Destination #9')
    preview.mockRejectedValueOnce(new Error('Preview evaluation failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    view.unmount()
  })
  it('does not call the API before the current Route sample is ready', () => {
    render(<SavedRouteProcessingPreview {...props} ready={false} />)
    expect(preview).not.toHaveBeenCalled()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
  it('shows the actual blocked decision without inventing a destination payload', async () => {
    const result = response(); result.delivery_allowed = false; result.policy_action = 'quarantine'
    result.final_events = []; result.preview_messages = []
    result.stage_previews = { ...result.stage_previews, policy: [], destination: [] }
    preview.mockResolvedValue(result)
    render(<SavedRouteProcessingPreview {...props} />)
    await screen.findByText('SYSLOG_UDP · Destination #9')
    fireEvent.click(screen.getByTestId('processing-preview-stage-destination'))
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('quarantine')
    expect(screen.getByTestId('processing-preview-stage-comparison')).not.toHaveTextContent('synthetic syslog message')
  })
})


describe('M3 preview error privacy', () => {
  it('explains persistence-only actions without echoing raw exception data', async () => {
    preview.mockRejectedValue(new Error('409: [PREVIEW_PERSISTENCE_REQUIRED] secret-do-not-render'))
    render(<SavedRouteProcessingPreview {...props} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Tokenization needs persisted token state')
    expect(screen.queryByText(/secret-do-not-render/)).not.toBeInTheDocument()
  })
  it('invalidates output immediately when the same Route sample revision changes', async () => {
    const view = render(<SavedRouteProcessingPreview {...props} />)
    await screen.findByText('SYSLOG_UDP · Destination #9')
    preview.mockReturnValue(new Promise(() => {}))
    view.rerender(<SavedRouteProcessingPreview {...props} revision="saved-2" />)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('SYSLOG_UDP · Destination #9')).not.toBeInTheDocument()
  })
})


describe('M3 field-warning inspection', () => {
  it('shows a real field/rule/code warning in the affected selected stage', async () => {
    const result = response()
    result.preview_issue_count = 2
    result.preview_issues = [
      { stage: 'mapping', rule_id: 'extract-ip', output_field: 'source_ip', error_code: 'REGEX_NO_MATCH' },
      { stage: 'enrichment', rule_id: 'extract-action', output_field: 'action', error_code: 'REGEX_NO_MATCH' },
    ]
    preview.mockResolvedValue(result)
    render(<SavedRouteProcessingPreview {...props} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 field warnings'))
    expect(screen.getByTestId('processing-preview-stage-mapping')).toHaveTextContent('1 field warning')
    fireEvent.click(screen.getByTestId('processing-preview-stage-mapping'))
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('source_ip · extract-ip · REGEX_NO_MATCH')
    fireEvent.click(screen.getByTestId('processing-preview-stage-transform'))
    expect(screen.getByTestId('processing-preview-stage-comparison')).toHaveTextContent('action · extract-action · REGEX_NO_MATCH')
  })

  it('explicitly labels partial warning evidence and clears it on the next failed preview', async () => {
    const result = response()
    result.preview_issue_count = 120
    result.preview_issues_truncated = true
    result.preview_issues = [{ stage: 'mapping', rule_id: 'extract-ip', output_field: 'source_ip', error_code: 'REGEX_NO_MATCH' }]
    preview.mockResolvedValue(result)
    render(<SavedRouteProcessingPreview {...props} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('120 field warnings'))
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1 of 120')
    preview.mockRejectedValueOnce(new Error('failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }))
    await screen.findByRole('alert')
    expect(screen.queryByText(/120 field warnings/)).not.toBeInTheDocument()
  })
})
