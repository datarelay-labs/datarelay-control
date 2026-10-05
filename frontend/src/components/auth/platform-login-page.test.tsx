import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { readSession } from '../../auth/session'
import { PlatformLoginPage } from './platform-login-page'

describe('PlatformLoginPage', () => {
  it('uses the shared DataRelay master logo asset', () => {
    render(<PlatformLoginPage onAuthenticated={vi.fn()} />)

    const logo = screen.getByRole('img', { name: 'DataRelay logo' })
    expect(logo).toHaveAttribute('src', '/logo/datarelay-logo.svg?v=dr-monogram-6')
    expect(logo).toHaveAttribute('width', '169')
    expect(logo).toHaveAttribute('height', '108')
    expect(logo).toHaveClass('h-12', 'w-auto')
  })

  it('preserves the password visibility control during Foundation auth presentation migration', async () => {
    render(<PlatformLoginPage onAuthenticated={vi.fn()} />)
    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument()
  })

  it('stores must_change_password and advances to the password-change gate after bootstrap login', async () => {
    const onAuthenticated = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            user: {
              username: 'admin',
              role: 'ADMINISTRATOR',
              status: 'ACTIVE',
              must_change_password: true,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    render(<PlatformLoginPage onAuthenticated={onAuthenticated} />)

    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'admin')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    expect(readSession()?.user.must_change_password).toBe(true)
  })
})
