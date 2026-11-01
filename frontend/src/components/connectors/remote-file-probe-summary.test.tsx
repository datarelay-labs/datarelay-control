import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RemoteFileProbeSummary, redactConnectorAuthTestResponseForDisplay } from './remote-file-probe-summary'
import type { ConnectorAuthTestResponse } from '../../api/gdcRuntimePreview'

describe('RemoteFileProbeSummary', () => {
  it('shows connectivity fields', () => {
    const res: ConnectorAuthTestResponse = {
      ok: true,
      auth_type: 'REMOTE_FILE_POLLING',
      ssh_reachable: true,
      ssh_auth_ok: true,
      sftp_available: true,
      remote_directory_accessible: true,
      matched_file_count: 3,
      sample_remote_paths: ['/upload/a.ndjson'],
      host_key_status: 'strict',
    }
    render(<RemoteFileProbeSummary res={res} />)
    expect(screen.getByText(/SSH reachable/i)).toBeInTheDocument()
    expect(screen.getByText(/Authentication/i)).toBeInTheDocument()
    expect(screen.getByText(/upload\/a\.ndjson/)).toBeInTheDocument()
  })

  it('says "not attempted" instead of false when authentication or SFTP never ran (F-112)', () => {
    const res: ConnectorAuthTestResponse = {
      ok: false,
      auth_type: 'REMOTE_FILE_POLLING',
      ssh_reachable: true,
      ssh_auth_ok: null,
      sftp_available: null,
      remote_directory_accessible: false,
      host_key_status: 'strict',
    }
    render(<RemoteFileProbeSummary res={res} />)
    expect(screen.getByText(/Authentication:/i).parentElement).toHaveTextContent('Authentication: not attempted')
    expect(screen.getByText(/SFTP subsystem:/i).parentElement).toHaveTextContent('SFTP subsystem: not attempted')
  })

  it('still reports a real authentication failure as false', () => {
    const res: ConnectorAuthTestResponse = {
      ok: false,
      auth_type: 'REMOTE_FILE_POLLING',
      ssh_reachable: true,
      ssh_auth_ok: false,
      sftp_available: null,
    }
    render(<RemoteFileProbeSummary res={res} />)
    expect(screen.getByText(/Authentication:/i).parentElement).toHaveTextContent('Authentication: false')
  })
})

describe('redactConnectorAuthTestResponseForDisplay', () => {
  it('masks sensitive keys', () => {
    const res = {
      ok: true,
      auth_type: 'REMOTE_FILE_POLLING',
      ssh_auth_ok: true,
      bearer_token: 'secret',
    } as ConnectorAuthTestResponse
    const out = redactConnectorAuthTestResponseForDisplay(res)
    expect(out.bearer_token).toBe('[redacted]')
    expect(out.ssh_auth_ok).toBe(true)
  })
})
