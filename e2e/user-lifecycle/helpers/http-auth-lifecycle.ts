import type { Page } from '@playwright/test'
import type { ArtifactStore } from './artifacts.js'
import type { ApiClient } from './api.js'
import type { ConnectorsPage } from '../pages/connectors.page.js'

type HttpCreateOpts = Parameters<ConnectorsPage['fillHttpConnector']>[0]

type AuthVariant = {
  key: string
  authType: string
  path: string
  fields: Omit<HttpCreateOpts, 'name' | 'baseUrl' | 'authType'>
  secretValue?: string
}

type ExhaustiveAuthOptions = {
  page: Page
  connectors: ConnectorsPage
  api: ApiClient
  store: ArtifactStore
  runId: string
  wiremockBase: string
}

const successRe = /success|passed|healthy|\b200\b/i
const failureRe = /fail|error|401|403|404|unauthor|forbidden|denied|token|credential/i
async function findConnectorId(api: ApiClient, name: string): Promise<number | null> {
  for (let i = 0; i < 12; i++) {
    const rows = await api.listConnectors()
    const hit = rows.find((row) => String(row.name) === name)
    if (hit) return Number(hit.id)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return null
}

async function saveDetail(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(450)
}

async function testAuth(connectors: ConnectorsPage, path: string) {
  await connectors.setAuthTestPath(path)
  const result = await connectors.testAuth()
  return {
    success: successRe.test(result.visibleText),
    failure: failureRe.test(result.visibleText),
    reasonVisible: result.visibleText.trim().length > 0,
  }
}
export async function runExhaustiveHttpAuthLifecycle(opts: ExhaustiveAuthOptions): Promise<void> {
  const { page, connectors, api, store, runId, wiremockBase } = opts
  const authPrefix = `/ulc/${runId}/auth`
  const basicUser = `ulc-basic-${runId}`
  const basicPassword = `FAKE_BASIC_${runId}`
  const bearerToken = `FAKE_BEARER_${runId}`
  const headerKey = `FAKE_HEADER_${runId}`
  const queryKey = `FAKE_QUERY_${runId}`
  const oauthClient = `ulc-oauth-${runId}`
  const oauthSecret = `FAKE_OAUTH_SECRET_${runId}`
  const sessionUser = `ulc-session-${runId}`
  const sessionPassword = `FAKE_SESSION_${runId}`
  const refreshToken = `FAKE_REFRESH_${runId}`
  const vendorUser = `ulc-vendor-${runId}`
  const vendorKey = `FAKE_VENDOR_KEY_${runId}`

  const variants: AuthVariant[] = []
  const add = (variant: AuthVariant) => variants.push(variant)
  add({
    key: 'no_auth',
    authType: 'no_auth',
    path: `${authPrefix}/no-auth`,
    fields: {},
  })
  add({
    key: 'basic',
    authType: 'basic',
    path: `${authPrefix}/basic`,
    fields: { basicUser, basicPass: basicPassword },
    secretValue: basicPassword,
  })
  add({
    key: 'bearer',
    authType: 'bearer',
    path: `${authPrefix}/bearer`,
    fields: { bearerToken },
    secretValue: bearerToken,
  })
  add({
    key: 'api_key_header',
    authType: 'api_key',
    path: `${authPrefix}/api-key-header`,
    fields: { apiKeyName: 'X-ULC-Key', apiKeyValue: headerKey, apiKeyLocation: 'headers' },
    secretValue: headerKey,
  })
  add({
    key: 'api_key_query',
    authType: 'api_key',
    path: `${authPrefix}/api-key-query`,
    fields: { apiKeyName: 'api_token', apiKeyValue: queryKey, apiKeyLocation: 'query_params' },
    secretValue: queryKey,
  })
  add({
    key: 'oauth2_client_credentials',
    authType: 'oauth2_client_credentials',
    path: `${authPrefix}/oauth-events`,
    fields: {
      oauthClientId: oauthClient,
      oauthClientSecret: oauthSecret,
      oauthTokenUrl: `${wiremockBase}${authPrefix}/oauth-token`,
    },
    secretValue: oauthSecret,
  })
  add({
    key: 'session_login',
    authType: 'session_login',
    path: `${authPrefix}/session-events`,
    fields: {
      sessionLoginUrl: wiremockBase,
      sessionLoginPath: `${authPrefix}/session-login`,
      sessionUsername: sessionUser,
      sessionPassword,
    },
    secretValue: sessionPassword,
  })
  add({
    key: 'jwt_refresh_token',
    authType: 'jwt_refresh_token',
    path: `${authPrefix}/refresh-events`,
    fields: {
      refreshToken,
      tokenUrl: `${wiremockBase}${authPrefix}/refresh-token`,
    },
    secretValue: refreshToken,
  })
  add({
    key: 'vendor_jwt_exchange',
    authType: 'vendor_jwt_exchange',
    path: `${authPrefix}/vendor-events`,
    fields: {
      vendorUserId: vendorUser,
      vendorApiKey: vendorKey,
      vendorTokenUrl: `${wiremockBase}${authPrefix}/vendor-token`,
    },
    secretValue: vendorKey,
  })
  for (const variant of variants) {
    const scenarioId = `BFS003_AUTH_${variant.key.toUpperCase()}`
    if (store.scenarios.some((row) => row.id === scenarioId && row.status === 'PASS')) continue

    const name = `e2e-${runId}-auth-${variant.key}`
    try {
      await connectors.openCreate()
      await connectors.fillHttpConnector({
        name,
        baseUrl: wiremockBase,
        authType: variant.authType,
        ...variant.fields,
      })
      await connectors.save()
      const id = await findConnectorId(api, name)
      if (!id) throw new Error('connector not persisted from browser create')
      store.track('CONNECTOR', id, name, 'via:browser;auth-exhaustive')
      await connectors.openDetail(id)

      const positive = await testAuth(connectors, variant.path)
      let negative
      if (!variant.secretValue) {
        negative = await testAuth(connectors, `${authPrefix}/missing-no-auth`)
      } else {
        const secret = page.locator('input[type="password"]').first()
        if ((await secret.count()) !== 1) {
          throw new Error(`expected one secret input for ${variant.key}`)
        }
        await secret.fill('invalid')
        await saveDetail(page)
        negative = await testAuth(connectors, variant.path)
        await secret.fill(variant.secretValue)
        await saveDetail(page)
      }

      const recovered = await testAuth(connectors, variant.path)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const persistedAuthType = await page.getByLabel(/Authentication Type/i).inputValue().catch(() => '')
      const persisted = persistedAuthType === variant.authType
      const passed =
        positive.success &&
        negative.failure &&
        negative.reasonVisible &&
        recovered.success &&
        persisted

      store.rec(
        scenarioId,
        passed ? 'PASS' : 'FAIL',
        `positive=${positive.success} negative=${negative.failure} reason=${negative.reasonVisible} recovery=${recovered.success} persisted=${persisted}`,
        ['BROWSER_E2E', 'API_INTEGRATION'],
      )
    } catch (error) {
      store.rec(scenarioId, 'FAIL', String(error).slice(0, 220), ['BROWSER_E2E'])
    }
  }

  const rows = store.scenarios.filter((row) => row.id.startsWith('BFS003_AUTH_'))
  const complete = rows.length === variants.length && rows.every((row) => row.status === 'PASS')
  store.setFlag('BFS003_EXHAUSTIVE_AUTH', complete ? 'PASS' : 'FAIL')
}
