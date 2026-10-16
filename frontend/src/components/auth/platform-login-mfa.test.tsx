import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSession } from '../../auth/session'
import { PlatformLoginPage } from './platform-login-page'

const successful = {
  access_token: 'opaque-mfa-verified-token',
  refresh_token: 'opaque-mfa-verified-refresh',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  user: { username: 'operator', role: 'OPERATOR', status: 'ACTIVE' },
}

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

describe('Control password first, separate MFA step', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not persist JWT or authenticate when the server returns MFA_REQUIRED', async () => {
    const onAuthenticated = vi.fn()
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      mfa_required: true, challenge_token: 'short-lived-preauth-opaque',
      expires_at: '2026-10-09T17:00:00Z',
    })).mockResolvedValueOnce(json(successful))
    vi.stubGlobal('fetch', fetchMock)

    render(<PlatformLoginPage onAuthenticated={onAuthenticated} />)
    await userEvent.type(screen.getByLabelText('Username'), 'operator')
    await userEvent.type(screen.getByLabelText('Password'), 'ValidPassword9')
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    expect(await screen.findByTestId('gdc-mfa-challenge')).toBeInTheDocument()
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(readSession()).toBeNull()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const req = fetchMock.mock.calls[0][1]
    expect(JSON.parse(req.body)).toEqual({ username: 'operator', password: 'ValidPassword9' })

    await userEvent.type(screen.getByLabelText('6-digit authentication code'), '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }))
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    expect(readSession()?.access_token).toBe('opaque-mfa-verified-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      challenge_token: 'short-lived-preauth-opaque',
      totp: '123456', recovery_code: '',
    })
  })

  it('requires another password attempt after a failed one-use MFA challenge', async () => {
    const authenticated = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ mfa_required: true, challenge_token: 'one-use-otp', expires_at: '2026-10-09T17:00:00Z' }))
      .mockResolvedValueOnce(json({ detail: { error_code: 'MFA_VERIFICATION_FAILED' } }, 401))
    vi.stubGlobal('fetch', fetchMock)
    render(<PlatformLoginPage onAuthenticated={authenticated} />)
    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'ValidPassword9')
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    expect(await screen.findByTestId('gdc-mfa-challenge')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('6-digit authentication code'), '111111')
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in again')
    expect(screen.queryByTestId('gdc-mfa-challenge')).not.toBeInTheDocument()
    expect(authenticated).not.toHaveBeenCalled()
    expect(readSession()).toBeNull()
  })
})
