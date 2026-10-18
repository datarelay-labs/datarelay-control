import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorWritePayload } from '../../api/gdcConnectors'
import { WebhookReceiverFields } from './webhook-receiver-fields'

const baseForm: ConnectorWritePayload = {
  source_type: 'WEBHOOK_RECEIVER',
  auth_type: 'no_auth',
  receiver_key: 'rx-readable',
  webhook_auth_mode: 'shared_secret_header',
  webhook_auth_header_name: 'X-GDC-Webhook-Secret',
  webhook_shared_secret: '',
  max_request_bytes: 1048576,
  payload_preview: '{"id":"example"}',
}

const set = vi.fn() as <K extends keyof ConnectorWritePayload>(
  key: K,
  value: ConnectorWritePayload[K],
) => void

describe('WebhookReceiverFields readability and accessible labels', () => {
  it('labels essential controls at readable size and explains the inbound POST path', () => {
    render(<WebhookReceiverFields form={baseForm} set={set} sharedSecretConfigured />)

    const receiver = screen.getByLabelText('Receiver URL')
    expect(receiver).toHaveValue(`${window.location.origin}/api/v1/ingest/webhook/rx-readable`)
    expect(receiver).toHaveClass('text-sm')
    expect(screen.getByText('Receiver URL')).toHaveClass('text-sm')
    expect(screen.getByRole('button', { name: 'Copy URL' })).toHaveClass('text-sm')
    expect(screen.getByLabelText('Auth mode')).toHaveValue('shared_secret_header')
    expect(screen.getByLabelText('Shared secret header name')).toHaveValue('X-GDC-Webhook-Secret')
    expect(screen.getByLabelText('Shared secret')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Shared secret')).toHaveValue('')
    expect(screen.getByLabelText('Max request bytes')).toHaveValue(1048576)
    expect(screen.getByLabelText('Payload preview')).toHaveClass('text-sm')
    expect(screen.getByText(/HTTP POST to this receiver URL/)).toBeInTheDocument()
    expect(screen.getByText(/Opening the URL in a browser does not send an event/)).toBeInTheDocument()
  })

  it('shows an explicit bearer-token label without exposing stored credentials', () => {
    render(
      <WebhookReceiverFields
        form={{ ...baseForm, webhook_auth_mode: 'bearer_token', webhook_bearer_token: '' }}
        set={set}
        bearerTokenConfigured
      />,
    )

    expect(screen.getByLabelText('Bearer token')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Bearer token')).toHaveValue('')
    expect(screen.getByPlaceholderText('Bearer token configured')).toBeInTheDocument()
    expect(screen.queryByLabelText('Shared secret')).not.toBeInTheDocument()
  })

  it('does not advertise a receiver URL before the key is saved', () => {
    render(<WebhookReceiverFields form={{ ...baseForm, receiver_key: '' }} set={set} />)
    expect(screen.getByLabelText('Receiver URL')).toHaveValue('Generated after save')
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeDisabled()
  })
})
