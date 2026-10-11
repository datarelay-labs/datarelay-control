import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminManagementAclPreview } from './admin-management-acl-preview'
import { postAdminManagementAclPreview } from '../../api/gdcAdmin'

vi.mock('../../api/gdcAdmin', () => ({
  postAdminManagementAclPreview: vi.fn(),
}))

const previewResult = {
  mode: 'PREVIEW_ONLY' as const,
  apply_available: false as const,
  ssh_enforcement_available: false as const,
  web_enforcement_available: false as const,
  observed_api_source: '203.0.113.9',
  web_reason: 'DENY_NO_MATCH',
  web_source_matches: false,
  ssh_reason: 'ALLOW_DISABLED',
  blockers: [
    'OFFLINE_RECOVERY_REQUIRED',
    'WEB_PROXY_AND_API_ATOMIC_ENFORCEMENT_UNAVAILABLE',
    'HOST_SSH_APPLY_AND_ROLLBACK_UNAVAILABLE',
  ],
  candidate_web_enabled: true,
  candidate_ssh_enabled: false,
  rollback_seconds: 180,
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  vi.mocked(postAdminManagementAclPreview).mockResolvedValue(previewResult)
})

describe('Management access draft-only UI', () => {
  it('previews canonical CIDRs without exposing save, apply, or enable', async () => {
    const user = userEvent.setup()
    render(<AdminManagementAclPreview isAdministrator />)
    expect(screen.getByTestId('admin-management-acl-preview')).toHaveTextContent('Preview only — not enforced')
    expect(screen.getByText(/No access restrictions are active from this preview/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /apply|save policy|enable access/i })).not.toBeInTheDocument()
    expect(postAdminManagementAclPreview).not.toHaveBeenCalled()

    await user.click(screen.getByLabelText(/Evaluate a restricted Web\/UI \+ API policy/))
    await user.type(screen.getByLabelText('Proposed Web/UI + API source IPs or CIDRs'),
      '203.0.113.0/24, 2001:db8::/64')
    await user.click(screen.getByRole('button', { name: 'Preview proposal only' }))

    await waitFor(() => {
      expect(postAdminManagementAclPreview).toHaveBeenCalledWith({
        web: {
          enabled: true,
          sources: [{ cidr: '203.0.113.0/24' }, { cidr: '2001:db8::/64' }],
        },
        ssh: { enabled: false, sources: [] },
        rollback_seconds: 180,
      })
    })
    const res = await screen.findByTestId('management-acl-preview-result')
    expect(res).toHaveTextContent('Observed API peer: 203.0.113.9')
    expect(res).toHaveTextContent('Enforcement: Unavailable for SSH and Web UI/API')
    expect(within(res).getByText('OFFLINE RECOVERY REQUIRED')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /apply|save policy/i })).not.toBeInTheDocument()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('hides actionable preview from non-admin roles', async () => {
    const user = userEvent.setup()
    render(<AdminManagementAclPreview isAdministrator={false} />)
    expect(screen.getByRole('button', { name: 'Preview proposal only' })).toBeDisabled()
    expect(screen.getByLabelText(/Evaluate a restricted host SSH policy/)).toBeDisabled()
    expect(screen.getByLabelText('Proposed Web/UI + API source IPs or CIDRs')).toBeDisabled()
    expect(screen.getByText(/Only an Administrator may preview/)).toBeInTheDocument()
    await user.click(screen.getByText(/Only an Administrator may preview/))
    expect(postAdminManagementAclPreview).not.toHaveBeenCalled()
  })

  it('renders server-side policy validation errors without implied activation', async () => {
    vi.mocked(postAdminManagementAclPreview).mockRejectedValueOnce(new Error('invalid IP/CIDR'))
    const user = userEvent.setup()
    render(<AdminManagementAclPreview isAdministrator />)
    await user.click(screen.getByRole('button', { name: 'Preview proposal only' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid IP/CIDR')
    expect(screen.queryByTestId('management-acl-preview-result')).not.toBeInTheDocument()
    expect(screen.getByText(/No access restrictions are active from this preview/)).toBeInTheDocument()
  })
})
