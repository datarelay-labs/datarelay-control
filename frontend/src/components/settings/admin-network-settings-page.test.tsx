import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAdminNetworkSettings,
  getAuthWhoAmI,
  postAdminNetworkSettingsApply,
  putAdminNetworkSettings,
  type NetworkSettingsApplyDto,
  type NetworkSettingsDto,
  type NetworkSettingsSaveDto,
} from '../../api/gdcAdmin'
import { AdminNetworkSettingsPage } from './admin-network-settings-page'

vi.mock('../../api/gdcAdmin', () => ({
  getAdminNetworkSettings: vi.fn(),
  postAdminNetworkSettingsApply: vi.fn(),
  putAdminNetworkSettings: vi.fn(),
  getAuthWhoAmI: vi.fn(),
}))

const restartCommand = 'docker compose -f docker-compose.platform.yml up -d --force-recreate reverse-proxy'

const initialSettings: NetworkSettingsDto = {
  http_port: 18080,
  https_port: 18443,
  env_example: {
    GDC_HTTP_PORT: '18080',
    GDC_HTTPS_PORT: '18443',
  },
  restart_required: false,
  restart_command: restartCommand,
}

let networkSettingsResponse: NetworkSettingsDto = initialSettings

function savedSettings(overrides: Partial<NetworkSettingsSaveDto> = {}): NetworkSettingsSaveDto {
  return {
    http_port: 19080,
    https_port: 19443,
    env_example: {
      GDC_HTTP_PORT: '19080',
      GDC_HTTPS_PORT: '19443',
    },
    restart_required: true,
    restart_command: restartCommand,
    message: 'Network settings saved to the database and platform .env. Apply the reverse-proxy change to update published ports.',
    ...overrides,
  }
}

function applyResult(overrides: Partial<NetworkSettingsApplyDto> = {}): NetworkSettingsApplyDto {
  return {
    success: true,
    command: restartCommand,
    stdout: 'recreated\n',
    stderr: '',
    exit_code: 0,
    message: 'Reverse proxy recreated. Reconnect using the configured HTTP/HTTPS port if the browser disconnects.',
    ...overrides,
  }
}

describe('AdminNetworkSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('gdc_platform_ui_role', 'ADMINISTRATOR')
    networkSettingsResponse = initialSettings
    vi.mocked(getAdminNetworkSettings).mockReset()
    vi.mocked(getAdminNetworkSettings).mockImplementation(async () => networkSettingsResponse)
    vi.mocked(putAdminNetworkSettings).mockResolvedValue(savedSettings())
    vi.mocked(postAdminNetworkSettingsApply).mockResolvedValue(applyResult())
    vi.mocked(getAuthWhoAmI).mockResolvedValue({ username: 'admin', role: 'ADMINISTRATOR', authenticated: true })
  })

  async function expectLoadedPorts(http: string, https: string): Promise<void> {
    await waitFor(() => {
      expect(screen.getByLabelText('HTTP Port')).toHaveValue(http)
      expect(screen.getByLabelText('HTTPS Port')).toHaveValue(https)
    })
  }

  it('loads and displays current HTTP and HTTPS ports', async () => {
    render(<AdminNetworkSettingsPage />)

    expect(await screen.findByRole('heading', { name: 'Network / Reverse Proxy Settings' })).toBeInTheDocument()
    expect(screen.getByLabelText('HTTP Port')).toHaveValue('18080')
    expect(screen.getByLabelText('HTTPS Port')).toHaveValue('18443')
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTP_PORT=18080')
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTPS_PORT=18443')
  })

  it('does not swap HTTP and HTTPS field bindings', async () => {
    networkSettingsResponse = {
      http_port: 18081,
      https_port: 18444,
      env_example: {
        GDC_HTTP_PORT: '18081',
        GDC_HTTPS_PORT: '18444',
      },
      restart_required: false,
      restart_command: restartCommand,
    }

    render(<AdminNetworkSettingsPage />)

    await expectLoadedPorts('18081', '18444')
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTP_PORT=18081')
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTPS_PORT=18444')
  })

  it('loads intentionally crossed ports without normalizing or swapping them', async () => {
    networkSettingsResponse = {
      http_port: 18443,
      https_port: 18080,
      env_example: {
        GDC_HTTP_PORT: '18443',
        GDC_HTTPS_PORT: '18080',
      },
      restart_required: false,
      restart_command: restartCommand,
    }

    render(<AdminNetworkSettingsPage />)

    await expectLoadedPorts('18443', '18080')
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTP_PORT=18443')
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTPS_PORT=18080')
  })

  it('keeps the environment preview bound to the HTTP and HTTPS fields', async () => {
    const user = userEvent.setup()
    render(<AdminNetworkSettingsPage />)
    const http = await screen.findByLabelText('HTTP Port')
    const https = screen.getByLabelText('HTTPS Port')
    await waitFor(() => expect(http).not.toBeDisabled())

    await user.clear(http)
    await user.type(http, '19080')
    await user.clear(https)
    await user.type(https, '19443')

    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTP_PORT=19080')
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTPS_PORT=19443')
  })

  it('validates required, numeric, range, and duplicate ports before submit', async () => {
    const user = userEvent.setup()
    render(<AdminNetworkSettingsPage />)
    const http = await screen.findByLabelText('HTTP Port')
    const https = screen.getByLabelText('HTTPS Port')
    await waitFor(() => expect(http).not.toBeDisabled())

    await user.clear(http)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByText('HTTP Port is required.')).toBeInTheDocument()

    await user.type(http, 'abc')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByText('HTTP Port must contain numbers only.')).toBeInTheDocument()

    await user.clear(http)
    await user.type(http, '70000')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByText('HTTP Port must be a valid TCP port between 1 and 65535.')).toBeInTheDocument()

    await user.clear(http)
    await user.type(http, '19080')
    await user.clear(https)
    await user.type(https, '19080')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByText('HTTP Port and HTTPS Port cannot match.')).toBeInTheDocument()
    expect(putAdminNetworkSettings).not.toHaveBeenCalled()
  })

  it('saves valid ports and renders restart-required guidance', async () => {
    const user = userEvent.setup()
    render(<AdminNetworkSettingsPage />)
    const http = await screen.findByLabelText('HTTP Port')
    const https = screen.getByLabelText('HTTPS Port')
    await waitFor(() => expect(http).not.toBeDisabled())

    await user.clear(http)
    await user.type(http, '19080')
    await user.clear(https)
    await user.type(https, '19443')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(putAdminNetworkSettings).toHaveBeenCalledWith({ http_port: 19080, https_port: 19443 })
    expect(await screen.findByText('Network settings saved')).toBeInTheDocument()
    expect(screen.getByTestId('admin-network-save-result')).toHaveTextContent('Restart required')
    expect(screen.getByRole('button', { name: 'Apply reverse-proxy change' })).toBeInTheDocument()
    expect(screen.getByText(/reconnect using HTTP 19080 or HTTPS 19443/i)).toBeInTheDocument()
  })

  it('sends intentionally crossed HTTP and HTTPS ports without reversing payload fields', async () => {
    const user = userEvent.setup()
    vi.mocked(putAdminNetworkSettings).mockResolvedValueOnce(
      savedSettings({
        http_port: 18443,
        https_port: 18080,
        env_example: {
          GDC_HTTP_PORT: '18443',
          GDC_HTTPS_PORT: '18080',
        },
      }),
    )
    render(<AdminNetworkSettingsPage />)
    const http = await screen.findByLabelText('HTTP Port')
    const https = screen.getByLabelText('HTTPS Port')
    await waitFor(() => expect(http).not.toBeDisabled())

    await user.clear(http)
    await user.type(http, '18443')
    await user.clear(https)
    await user.type(https, '18080')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(putAdminNetworkSettings).toHaveBeenCalledWith({ http_port: 18443, https_port: 18080 })
    expect(await screen.findByText('Network settings saved')).toBeInTheDocument()
    expect(screen.getByText(/reconnect using HTTP 18443 or HTTPS 18080/i)).toBeInTheDocument()
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTP_PORT=18443')
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTPS_PORT=18080')
  })

  it('applies reverse-proxy changes from the browser and keeps command output behind disclosure', async () => {
    const user = userEvent.setup()
    render(<AdminNetworkSettingsPage />)

    const http = await screen.findByLabelText('HTTP Port')
    await waitFor(() => expect(http).not.toBeDisabled())
    await user.click(screen.getByRole('button', { name: 'Apply reverse-proxy change' }))

    expect(postAdminNetworkSettingsApply).toHaveBeenCalledWith()
    expect(await screen.findByText('Reverse proxy applied')).toBeInTheDocument()
    expect(screen.getByTestId('admin-network-apply-command')).toHaveTextContent(`${restartCommand} exited with 0`)
    expect(screen.getByTestId('admin-network-apply-output')).toHaveTextContent('recreated')
  })

  it('shows save → apply → reconnect workflow and current-state hierarchy', async () => {
    render(<AdminNetworkSettingsPage />)
    expect(await screen.findByTestId('admin-network-workflow')).toHaveTextContent('Save ports')
    expect(screen.getByTestId('admin-network-workflow')).toHaveTextContent('Apply reverse proxy')
    expect(screen.getByTestId('admin-network-workflow')).toHaveTextContent('Reconnect / result')
    expect(screen.getByTestId('admin-network-current-state')).toHaveTextContent('Saved HTTP port')
    expect(screen.getByTestId('admin-network-configuration')).toBeInTheDocument()
    expect(screen.getByTestId('admin-network-safeguards')).toHaveTextContent(/Apply required after saving/i)
    expect(screen.getByTestId('network-env-example')).toHaveTextContent('GDC_HTTP_PORT=18080')
  })

  it('keeps environment values available for troubleshooting without elevating them', async () => {
    render(<AdminNetworkSettingsPage />)
    await screen.findByLabelText('HTTP Port')
    expect(screen.getByText('Environment values (.env)')).toBeInTheDocument()
    expect(screen.getByTestId('network-env-example')).toBeInTheDocument()
  })

  it('disables network mutations for non-Administrator sessions', async () => {
    vi.mocked(getAuthWhoAmI).mockResolvedValue({ username: 'ops', role: 'OPERATOR', authenticated: true })
    render(<AdminNetworkSettingsPage />)
    const http = await screen.findByLabelText('HTTP Port')
    await waitFor(() => expect(http).toBeDisabled())
    expect(screen.getByTestId('admin-network-readonly')).toHaveTextContent(/Administrator role is required/i)
    expect(screen.getByTestId('admin-network-save')).toBeDisabled()
    expect(screen.getByTestId('admin-network-apply')).toBeDisabled()
  })

  it('shows reconnect guidance when reverse-proxy apply interrupts the request', async () => {
    const user = userEvent.setup()
    let rejectApply: (reason?: unknown) => void = () => undefined
    vi.mocked(postAdminNetworkSettingsApply).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectApply = reject
      }),
    )
    render(<AdminNetworkSettingsPage />)

    const http = await screen.findByLabelText('HTTP Port')
    await waitFor(() => expect(http).not.toBeDisabled())
    await user.click(screen.getByRole('button', { name: 'Apply reverse-proxy change' }))

    expect(screen.getByRole('status')).toHaveTextContent('Applying reverse-proxy change...')
    rejectApply(new TypeError('Failed to fetch'))

    expect(await screen.findByText('Reverse proxy request interrupted')).toBeInTheDocument()
    expect(
      screen.getByText('The reverse proxy may have restarted and interrupted this browser request. Check the configured port and reconnect.'),
    ).toBeInTheDocument()
    expect(screen.getByText('http://localhost:18080')).toBeInTheDocument()
    expect(screen.getByText('https://localhost:18443')).toBeInTheDocument()
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument()
  })

  it('shows crossed reconnect URLs using HTTP and HTTPS draft ports after interrupted apply', async () => {
    const user = userEvent.setup()
    networkSettingsResponse = {
      http_port: 18443,
      https_port: 18080,
      env_example: {
        GDC_HTTP_PORT: '18443',
        GDC_HTTPS_PORT: '18080',
      },
      restart_required: false,
      restart_command: restartCommand,
    }
    vi.mocked(postAdminNetworkSettingsApply).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    render(<AdminNetworkSettingsPage />)

    const http = await screen.findByLabelText('HTTP Port')
    await expectLoadedPorts('18443', '18080')
    await waitFor(() => expect(http).not.toBeDisabled())
    await user.click(screen.getByRole('button', { name: 'Apply reverse-proxy change' }))

    expect(await screen.findByText('Reverse proxy request interrupted')).toBeInTheDocument()
    expect(screen.getByText('http://localhost:18443')).toBeInTheDocument()
    expect(screen.getByText('https://localhost:18080')).toBeInTheDocument()
    expect(screen.queryByText('http://localhost:18080')).not.toBeInTheDocument()
    expect(screen.queryByText('https://localhost:18443')).not.toBeInTheDocument()
  })

  it('renders backend validation errors cleanly', async () => {
    vi.mocked(putAdminNetworkSettings).mockRejectedValueOnce(
      new Error('422: [NETWORK_PORT_INVALID] Port 8000 is a reserved platform service port.'),
    )
    const user = userEvent.setup()
    render(<AdminNetworkSettingsPage />)
    const http = await screen.findByLabelText('HTTP Port')
    await waitFor(() => expect(http).not.toBeDisabled())

    await user.clear(http)
    await user.type(http, '8000')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Port 8000 is a reserved platform service port.')
    expect(screen.queryByText('[NETWORK_PORT_INVALID]')).not.toBeInTheDocument()
  })
})
