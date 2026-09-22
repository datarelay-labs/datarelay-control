import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAdminDisplaySettings } from '../../api/gdcAdmin'
import { listIanaTimezones } from '../../lib/iana-timezones'
import { AdminDisplayTimezoneSettings } from './admin-display-timezone-settings'

const setUserTimezone = vi.fn()
const setPlatformDefaultTimezone = vi.fn()

vi.mock('../../api/gdcAdmin', () => ({
  getAdminDisplaySettings: vi.fn(),
}))

vi.mock('../../contexts/display-timezone-context', () => ({
  useDisplayTimezone: () => ({
    timezone: 'UTC',
    userTimezone: null,
    platformDefaultTimezone: 'UTC',
    setUserTimezone,
    setPlatformDefaultTimezone,
    formatTimestamp: () => '2026-06-29 07:10 UTC',
  }),
}))

describe('listIanaTimezones', () => {
  it('includes previously hard-coded and non-hard-coded IANA zones', () => {
    const zones = listIanaTimezones()
    expect(zones).toEqual(expect.arrayContaining(['UTC', 'Asia/Seoul', 'America/New_York', 'Europe/London']))
    expect(zones).toContain('America/Los_Angeles')
    expect(zones).toContain('Europe/Berlin')
    expect(zones.length).toBeGreaterThan(4)
  })
})

describe('AdminDisplayTimezoneSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAdminDisplaySettings).mockResolvedValue({ default_timezone: 'UTC' })
    setUserTimezone.mockResolvedValue(undefined)
    setPlatformDefaultTimezone.mockResolvedValue(undefined)
  })

  function renderSettings(overrides: Partial<Parameters<typeof AdminDisplayTimezoneSettings>[0]> = {}) {
    const props = {
      backendRole: 'ADMINISTRATOR',
      readOnly: false,
      busy: false,
      setBusy: vi.fn(),
      setPageMsg: vi.fn(),
      setPageErr: vi.fn(),
      ...overrides,
    }
    return render(<AdminDisplayTimezoneSettings {...props} />)
  }

  it('shows current-state before personal and platform controls', () => {
    renderSettings()
    expect(screen.getByTestId('admin-display-timezone-panel')).toBeInTheDocument()
    expect(screen.getByTestId('admin-display-timezone-current-state')).toHaveTextContent('Effective display timezone')
    expect(screen.getByTestId('admin-display-timezone-current-state')).toHaveTextContent('Platform default')
    expect(screen.getByTestId('admin-display-timezone-personal')).toBeInTheDocument()
    expect(screen.getByTestId('admin-display-timezone-platform')).toBeInTheDocument()
    expect(screen.getByTestId('admin-display-timezone-example')).toHaveTextContent('2026-06-29 07:10 UTC')
  })

  it('lets an operator select and save a previously unavailable user timezone', async () => {
    const user = userEvent.setup()
    const setPageMsg = vi.fn()
    renderSettings({ backendRole: 'OPERATOR', setPageMsg })

    const userSelect = screen.getByLabelText('IANA timezone', { selector: '#user-display-timezone' })
    expect(within(userSelect).getByRole('option', { name: '(use platform / browser)' })).toBeInTheDocument()
    expect(within(userSelect).queryByRole('option', { name: 'America/Los_Angeles' })).toBeInTheDocument()

    await user.selectOptions(userSelect, 'America/Los_Angeles')
    await user.click(screen.getByRole('button', { name: 'Save my timezone' }))

    await waitFor(() => {
      expect(setUserTimezone).toHaveBeenCalledWith('America/Los_Angeles')
    })
    expect(setPageMsg).toHaveBeenCalledWith('Your display timezone was updated.')
  })

  it('lets an administrator select and save a previously unavailable platform default timezone', async () => {
    const user = userEvent.setup()
    const setPageMsg = vi.fn()
    renderSettings({ setPageMsg })

    await waitFor(() => {
      expect(getAdminDisplaySettings).toHaveBeenCalled()
    })

    const platformSelect = screen.getByLabelText('IANA timezone', { selector: '#platform-display-timezone' })
    expect(within(platformSelect).queryByRole('option', { name: 'Europe/Berlin' })).toBeInTheDocument()

    await user.selectOptions(platformSelect, 'Europe/Berlin')
    await user.click(screen.getByRole('button', { name: 'Save platform default' }))

    await waitFor(() => {
      expect(setPlatformDefaultTimezone).toHaveBeenCalledWith('Europe/Berlin')
    })
    expect(setPageMsg).toHaveBeenCalledWith('Platform default timezone saved.')
  })

  it('locks platform default controls for Operator while keeping personal override available', () => {
    renderSettings({ backendRole: 'OPERATOR' })
    expect(screen.getByTestId('admin-display-timezone-platform-locked')).toHaveTextContent(/Administrator only/i)
    expect(screen.getByLabelText('IANA timezone', { selector: '#platform-display-timezone' })).toBeDisabled()
    expect(screen.getByTestId('admin-display-timezone-save-platform')).toBeDisabled()
    expect(screen.getByLabelText('IANA timezone', { selector: '#user-display-timezone' })).toBeEnabled()
    expect(screen.getByTestId('admin-display-timezone-save-user')).toBeEnabled()
  })

  it('disables timezone mutations for Viewer sessions', () => {
    renderSettings({ backendRole: 'VIEWER', readOnly: true })
    expect(screen.getByLabelText('IANA timezone', { selector: '#user-display-timezone' })).toBeDisabled()
    expect(screen.getByTestId('admin-display-timezone-save-user')).toBeDisabled()
    expect(screen.getByLabelText('IANA timezone', { selector: '#platform-display-timezone' })).toBeDisabled()
    expect(screen.getByTestId('admin-display-timezone-save-platform')).toBeDisabled()
  })

  it('filters timezone options by search text', async () => {
    const user = userEvent.setup()
    renderSettings()

    const filters = screen.getAllByLabelText('Filter timezones')
    await user.type(filters[0]!, 'Los_Angeles')

    const userSelect = screen.getByLabelText('IANA timezone', { selector: '#user-display-timezone' })
    expect(within(userSelect).getByRole('option', { name: 'America/Los_Angeles' })).toBeInTheDocument()
    expect(within(userSelect).queryByRole('option', { name: 'Europe/London' })).not.toBeInTheDocument()
    expect(within(userSelect).getByRole('option', { name: '(use platform / browser)' })).toBeInTheDocument()
  })
})
