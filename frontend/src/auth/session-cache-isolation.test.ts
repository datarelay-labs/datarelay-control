import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSharedRequestCache, cachedRequest } from '../api/requestCache'
import { writeDestinationsListSnapshot, readDestinationsListSnapshot } from '../components/destinations/destinations-list-cache'
import { writeConnectorsOverviewSnapshot, readConnectorsOverviewSnapshot } from '../components/connectors/connectors-overview-cache'
import { writeStreamsConsoleSnapshot, readStreamsConsoleSnapshot } from '../components/streams/streams-console-cache'
import { readAdminSettingsSnapshot, writeAdminSettingsSnapshot } from '../components/settings/admin-settings-session-cache'
import { clearSession, persistSession } from './session'

describe('auth cache isolation', () => {
  beforeEach(() => {
    clearSharedRequestCache()
    localStorage.clear()
  })

  it('clearSession drops shared request and session UI caches', async () => {
    await cachedRequest('catalog-destinations', 'list', async () => [{ id: 1 }])
    await cachedRequest('catalog-destination-by-id', '7', async () => ({ id: 7, name: 'cached-dest' }))
    await cachedRequest('catalog-route-by-id', '42', async () => ({ id: 42, name: 'cached-route' }))
    writeDestinationsListSnapshot([
      {
        id: 1,
        name: 'D',
        destination_type: 'WEBHOOK_POST',
        config_json: {},
        rate_limit_json: {},
        enabled: true,
        streams_using_count: 0,
        routes: [],
      },
    ])
    writeConnectorsOverviewSnapshot({
      baseRows: [{ id: 1 } as never],
      opsRows: [],
      operationsBacked: false,
    })
    writeStreamsConsoleSnapshot({
      displayRows: [{ id: 1 } as never],
      workflowExtrasByStreamId: {},
      sectionKpi: {} as never,
    })

    persistSession({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'admin', role: 'ADMINISTRATOR', status: 'active' },
    })

    clearSession()

    expect(readDestinationsListSnapshot()).toBeNull()
    expect(readConnectorsOverviewSnapshot()).toBeNull()
    expect(readStreamsConsoleSnapshot()).toBeNull()

    const loader = vi.fn(async () => [{ id: 2 }])
    await cachedRequest('catalog-destinations', 'list', loader)
    expect(loader).toHaveBeenCalledTimes(1)

    const destByIdLoader = vi.fn(async () => ({ id: 7, name: 'fresh-dest' }))
    const routeByIdLoader = vi.fn(async () => ({ id: 42, name: 'fresh-route' }))
    await cachedRequest('catalog-destination-by-id', '7', destByIdLoader)
    await cachedRequest('catalog-route-by-id', '42', routeByIdLoader)
    expect(destByIdLoader).toHaveBeenCalledTimes(1)
    expect(routeByIdLoader).toHaveBeenCalledTimes(1)
  })
})

describe('administration cache isolation across account changes', () => {
  it('clears privileged user and system snapshots when a session ends', () => {
    const adminData = {
      https: null,
      httpsDraft: null,
      users: [{ id: 7, username: 'admin-confidential' } as never],
      systemFooter: null,
    }
    writeAdminSettingsSnapshot(adminData)
    expect(readAdminSettingsSnapshot()).toEqual(adminData)

    // Authentication rejection also uses clearSession() without a full page
    // reload, so the next login must never inherit privileged admin data.
    clearSession()
    expect(readAdminSettingsSnapshot()).toBeNull()
  })
})

describe('account transition cache isolation', () => {
  it('drops previous account administration data on direct signed-in identity switch', () => {
    clearSession()
    persistSession({
      access_token: 'admin-access',
      refresh_token: 'admin-refresh',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'admin-one', role: 'ADMINISTRATOR', status: 'ACTIVE' },
    })
    writeAdminSettingsSnapshot({
      https: null,
      httpsDraft: null,
      users: [{ id: 8, username: 'private-admin-user' } as never],
      systemFooter: null,
    })
    expect(readAdminSettingsSnapshot()).not.toBeNull()

    // Session refresh does not switch identities; a separate user/role does.
    persistSession({
      access_token: 'viewer-access',
      refresh_token: 'viewer-refresh',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'viewer-two', role: 'VIEWER', status: 'ACTIVE' },
    })
    expect(readAdminSettingsSnapshot()).toBeNull()
  })
})
