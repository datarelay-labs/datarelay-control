import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminMfaEnrollment } from './admin-mfa-enrollment'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  confirm: vi.fn(),
  qr: vi.fn(),
}))

vi.mock('../../api/gdcAdmin', () => ({
  getAuthMfaStatus: mocks.status,
  postAuthMfaEnrollStart: mocks.start,
  postAuthMfaEnrollConfirm: mocks.confirm,
}))

vi.mock('qrcode', () => ({
  default: { toDataURL: mocks.qr },
}))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  mocks.status.mockResolvedValue({ enabled: false })
  mocks.start.mockResolvedValue({
    secret: 'LOCALTESTSECRETABC',
    otpauth_uri: 'otpauth://totp/DataRelay%20Control:test?secret=LOCALTESTSECRETABC',
    expires_at: '2099-01-01T00:00:00Z',
  })
  mocks.confirm.mockResolvedValue({ enabled: true, recovery_codes: ['backup-1', 'backup-2'] })
  mocks.qr.mockResolvedValue('data:image/png;base64,dGVzdA==')
})

describe('Administration self-service TOTP MFA', () => {
  it('is opt-in and asks for the signed-in account password before enrollment', async () => {
    const user = userEvent.setup()
    render(<AdminMfaEnrollment />)
    expect(await screen.findByTestId('admin-mfa-start')).toBeInTheDocument()
    const start = within(screen.getByTestId('admin-mfa-start'))
    expect(start.getByRole('button', { name: 'Set up authenticator' })).toBeDisabled()
    await user.type(start.getByLabelText('Current password'), 'current-password')
    await user.click(start.getByRole('button', { name: 'Set up authenticator' }))
    expect(mocks.start).toHaveBeenCalledWith('current-password')
    expect(await screen.findByTestId('admin-mfa-confirm')).toBeInTheDocument()
    expect(mocks.qr).toHaveBeenCalledWith(
      expect.stringContaining('otpauth://totp/'),
      expect.objectContaining({ width: 192 }),
    )
    expect(screen.getByAltText('TOTP authenticator enrollment QR code')).toHaveAttribute(
      'src', expect.stringMatching(/^data:image\/png;base64,/),
    )
    expect(screen.getByTestId('admin-mfa-manual-key')).toHaveTextContent('LOCALTESTSECRETABC')
    expect(screen.getByTestId('admin-mfa-confirm')).not.toHaveTextContent('current-password')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('does not reveal backup codes before a valid OTP and displays them only once', async () => {
    const user = userEvent.setup()
    render(<AdminMfaEnrollment />)
    await user.type(await screen.findByLabelText('Current password'), 'my-password')
    await user.click(screen.getByRole('button', { name: 'Set up authenticator' }))
    const confirm = await screen.findByTestId('admin-mfa-confirm')
    expect(screen.queryByTestId('admin-mfa-recovery-codes')).not.toBeInTheDocument()
    await user.type(within(confirm).getByLabelText('6-digit code from your authenticator'), '123456')
    await user.click(within(confirm).getByRole('button', { name: 'Verify and enable MFA' }))
    const codes = await screen.findByTestId('admin-mfa-recovery-codes')
    expect(mocks.confirm).toHaveBeenCalledWith('123456')
    expect(within(codes).getByText('backup-1')).toBeInTheDocument()
    expect(codes).toHaveTextContent('These codes appear only once')
    expect(screen.queryByTestId('admin-mfa-manual-key')).not.toBeInTheDocument()
    await user.click(within(codes).getByRole('button', { name: 'I have saved the recovery codes' }))
    expect(screen.queryByText('backup-1')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('MFA enabled')
  })

  it('keeps enrollment pending and never exposes codes on invalid OTP', async () => {
    mocks.confirm.mockRejectedValueOnce(new Error('Invalid authenticator code.'))
    const user = userEvent.setup()
    render(<AdminMfaEnrollment />)
    await user.type(await screen.findByLabelText('Current password'), 'correct-password')
    await user.click(screen.getByRole('button', { name: 'Set up authenticator' }))
    await user.type(await screen.findByLabelText('6-digit code from your authenticator'), '999999')
    await user.click(screen.getByRole('button', { name: 'Verify and enable MFA' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid authenticator code.')
    expect(screen.getByTestId('admin-mfa-confirm')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-mfa-recovery-codes')).not.toBeInTheDocument()
  })

  it('does not offer enrollment when already enabled or session unavailable', async () => {
    mocks.status.mockResolvedValueOnce({ enabled: true })
    const view = render(<AdminMfaEnrollment />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('MFA enabled'))
    expect(screen.queryByTestId('admin-mfa-start')).not.toBeInTheDocument()
    view.unmount()
    mocks.status.mockRejectedValueOnce(new Error('no authentication'))
    render(<AdminMfaEnrollment />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in with your local account')
    expect(screen.queryByTestId('admin-mfa-start')).not.toBeInTheDocument()
  })
})
