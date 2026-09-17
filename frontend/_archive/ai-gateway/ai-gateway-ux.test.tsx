import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AiStreamsPage } from './ai-streams-page'
import { AiProvidersPage } from './ai-providers-page'
import { AiTrafficPage } from './ai-traffic-page'
import * as gdcAiStreams from '../../api/gdcAiStreams'
import * as gdcAiProviders from '../../api/gdcAiProviders'
import * as gdcStreams from '../../api/gdcStreams'

describe('AI Gateway UX (M30.3)', () => {
  beforeEach(() => {
    vi.spyOn(gdcAiStreams, 'fetchAiStreamsList').mockResolvedValue([])
    vi.spyOn(gdcAiProviders, 'fetchAiProvidersList').mockResolvedValue([])
    vi.spyOn(gdcStreams, 'fetchStreamsList').mockResolvedValue([])
    vi.spyOn(gdcAiProviders, 'fetchAiTrafficSummary').mockResolvedValue({
      window_hours: 24,
      stream_id: null,
      requests: 0,
      success_count: 0,
      failure_count: 0,
      success_rate: 0,
      error_rate: 0,
      avg_latency_ms: 0,
      top_providers: [],
      failover_count: 0,
      replay_count: 0,
      inspected_count: 0,
      blocked_count: 0,
      masked_count: 0,
      redacted_count: 0,
      policy_blocks: 0,
      prompt_masks: 0,
      response_masks: 0,
    })
  })

  it('shows empty state CTA on AI providers page', async () => {
    render(
      <MemoryRouter>
        <AiProvidersPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('ai-providers-empty-state')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Configure Provider' })).toHaveAttribute('href', '/ai-gateway/providers')
  })

  it('shows empty state CTA on AI streams page', async () => {
    render(
      <MemoryRouter>
        <AiStreamsPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('ai-streams-empty-state')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create AI Stream' })).toHaveAttribute('href', '/streams')
  })

  it('renders operator columns without slug, model, or raw IDs', async () => {
    vi.spyOn(gdcAiStreams, 'fetchAiStreamsList').mockResolvedValue([
      {
        id: 1,
        stream_id: 10,
        provider_id: 20,
        slug: 'chat-api',
        model: 'gpt-4o',
        enabled: true,
      },
    ])
    vi.spyOn(gdcStreams, 'fetchStreamsList').mockResolvedValue([
      { id: 10, name: 'Support Bot', connector_id: 1, source_id: 1, enabled: true } as never,
    ])
    vi.spyOn(gdcAiProviders, 'fetchAiTrafficSummary').mockResolvedValue({
      window_hours: 24,
      stream_id: 10,
      requests: 42,
      success_count: 40,
      failure_count: 2,
      success_rate: 95,
      error_rate: 5,
      avg_latency_ms: 120,
      top_providers: [],
      failover_count: 0,
      replay_count: 0,
      inspected_count: 42,
      blocked_count: 0,
      masked_count: 0,
      redacted_count: 0,
      policy_blocks: 0,
      prompt_masks: 0,
      response_masks: 0,
    })

    render(
      <MemoryRouter>
        <AiStreamsPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Support Bot')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('2 failures')).toBeInTheDocument()
    expect(screen.queryByText('chat-api')).not.toBeInTheDocument()
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument()
    expect(screen.queryByText('10')).not.toBeInTheDocument()
    expect(screen.queryByText('20')).not.toBeInTheDocument()
  })

  it('shows traffic empty state when no requests recorded', async () => {
    render(
      <MemoryRouter>
        <AiTrafficPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('ai-traffic-empty-state')).toBeInTheDocument()
  })
})
