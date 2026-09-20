import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { StreamTemplatePicker } from './stream-template-picker'
import * as registryApi from '../../../api/gdcConnectorsRegistry'

vi.mock('../../../api/gdcConnectorsRegistry', () => ({
  fetchConnectorRegistryDetail: vi.fn(),
  fetchConnectorRegistryResources: vi.fn(),
}))

describe('StreamTemplatePicker', () => {
  beforeEach(() => {
    vi.mocked(registryApi.fetchConnectorRegistryDetail).mockResolvedValue({
      id: 'crowdstrike',
      resolved: {
        id: 'crowdstrike',
        name: 'CrowdStrike Falcon',
        vendor: 'CrowdStrike',
        version: '1.0.0',
        source_type: 'HTTP_API_POLLING',
        auth: { type: 'bearer' },
        auth_schema: null,
        streams: [],
        capabilities: {},
        status: 'valid',
        errors: [],
        resources: {
          streams_count: 2,
          mappings_count: 2,
          enrichments_count: 2,
          has_api_test: true,
          has_docs: true,
        },
        module_dir: 'connectors/crowdstrike',
        manifest_path: 'connectors/crowdstrike/manifest.yaml',
        manifest: null,
      },
    })
    vi.mocked(registryApi.fetchConnectorRegistryResources).mockResolvedValue({
      id: 'crowdstrike',
      status: 'valid',
      streams: {
        detections: { name: 'Detections poll stream', description: 'Detection summaries' },
        incidents: { name: 'Incidents poll stream' },
      },
      mappings: {},
      enrichments: {},
      api_test: null,
      docs: null,
      auth_schema: null,
      resources: {
        streams_count: 2,
        mappings_count: 2,
        enrichments_count: 2,
        has_api_test: true,
        has_docs: true,
      },
      errors: [],
    })
  })

  it('renders template options from registry resources', async () => {
    render(
      <StreamTemplatePicker moduleId="crowdstrike" selectedTemplateIds={[]} onSelectionChange={vi.fn()} />,
    )
    expect(await screen.findByTestId('stream-template-picker')).toBeInTheDocument()
    expect(screen.getByTestId('stream-template-option-detections')).toBeInTheDocument()
    expect(screen.getByTestId('stream-template-option-incidents')).toBeInTheDocument()
    expect(screen.getByText('Detections poll stream')).toBeInTheDocument()
  })

  it('persists selection via onSelectionChange', async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    render(
      <StreamTemplatePicker
        moduleId="crowdstrike"
        selectedTemplateIds={['detections']}
        onSelectionChange={onSelectionChange}
      />,
    )
    await screen.findByTestId('stream-template-picker')
    const incidents = screen.getByTestId('stream-template-checkbox-incidents')
    await user.click(incidents)
    expect(onSelectionChange).toHaveBeenCalledWith(['detections', 'incidents'])
  })

  it('shows fallback when module is invalid', async () => {
    vi.mocked(registryApi.fetchConnectorRegistryDetail).mockResolvedValue({
      id: 'okta',
      resolved: {
        id: 'okta',
        name: 'Okta',
        vendor: 'Okta',
        version: '1.0.0',
        source_type: 'HTTP_API_POLLING',
        auth: { type: 'api_key' },
        auth_schema: null,
        streams: [],
        capabilities: {},
        status: 'invalid',
        errors: [],
        resources: {
          streams_count: 0,
          mappings_count: 0,
          enrichments_count: 0,
          has_api_test: false,
          has_docs: false,
        },
        module_dir: 'connectors/okta',
        manifest_path: 'connectors/okta/manifest.yaml',
        manifest: null,
      },
    })
    render(<StreamTemplatePicker moduleId="okta" selectedTemplateIds={[]} onSelectionChange={vi.fn()} />)
    expect(await screen.findByTestId('stream-template-picker-fallback')).toBeInTheDocument()
  })

  it('returns null when moduleId is unset', () => {
    const { container } = render(
      <StreamTemplatePicker moduleId={null} selectedTemplateIds={[]} onSelectionChange={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
