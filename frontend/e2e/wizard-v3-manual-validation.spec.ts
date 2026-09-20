/**
 * Manual validation harness for Stream Wizard v3 critical fixes.
 * Run: cd frontend && PLAYWRIGHT_BASE_URL=http://127.0.0.1:18443 npx playwright test --config=playwright.config.manual-validation.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { expectAppShell } from './helpers/auth-flow'

const OUT_DIR = path.resolve('validation-output/wizard-v3-manual')
const DRAFT_KEY = 'gdc-stream-wizard-draft-v2'
const VALIDATION_PASSWORD = process.env.PLAYWRIGHT_E2E_PASSWORD?.trim() || 'GdcSmokeE2e!2026'
const CLOUDTRAIL = {
  ResponseMetadata: { RequestId: 'manual-val', HTTPStatusCode: 200 },
  Records: Array.from({ length: 5 }, (_, i) => ({
    event: {
      eventTime: `2024-01-15T14:${String(i).padStart(2, '0')}:00Z`,
      eventID: `evt-${i}`,
      eventVersion: '1.08',
    },
  })),
}

async function signInForValidation(page: Page, request: APIRequestContext) {
  const loginRes = await request.post('/api/v1/auth/login', {
    data: { username: 'admin', password: VALIDATION_PASSWORD },
  })
  if (!loginRes.ok()) {
    throw new Error(`Login failed: HTTP ${loginRes.status()}`)
  }
  let session = (await loginRes.json()) as {
    access_token: string
    refresh_token: string
    expires_at: string
    user: { username: string; role: string; status: string; must_change_password?: boolean }
  }
  if (session.user?.must_change_password) {
    const changeRes = await request.post('/api/v1/auth/change-password', {
      headers: { Authorization: `Bearer ${session.access_token}` },
      data: {
        current_password: VALIDATION_PASSWORD,
        new_password: VALIDATION_PASSWORD,
        confirm_new_password: VALIDATION_PASSWORD,
      },
    })
    if (!changeRes.ok()) {
      throw new Error(`Password change failed: HTTP ${changeRes.status()}`)
    }
    const relogin = await request.post('/api/v1/auth/login', {
      data: { username: 'admin', password: VALIDATION_PASSWORD },
    })
    session = (await relogin.json()) as typeof session
  }
  await page.goto('/')
  await page.evaluate(
    ({ sessionPayload }) => {
      localStorage.setItem('gdc_platform_session_v1', JSON.stringify(sessionPayload))
      localStorage.setItem('gdc-platform-persona', 'connector')
    },
    {
      sessionPayload: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user: session.user,
      },
    },
  )
  await page.reload({ waitUntil: 'networkidle' })
  await expectAppShell(page)
}

function stepButton(page: Page, title: string) {
  return page.locator('#wizard-stepper button').filter({ hasText: title })
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true })
}

async function clearDraft(page: Page) {
  await page.evaluate((key) => {
    localStorage.removeItem(key)
    localStorage.removeItem('gdc-stream-wizard-draft-v1')
  }, DRAFT_KEY)
}

async function seedDraft(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(
    ({ key, patch }) => {
      const base = {
        version: 2,
        savedAt: Date.now(),
        stepKey: 'connect',
        state: {
          connector: {
            connectorId: null,
            sourceId: null,
            connectorName: '',
            sourceType: 'HTTP_API_POLLING',
          },
          stream: { name: 'Draft Stream', endpoint: '/events' },
          apiTest: { status: 'idle', ok: false },
        },
      }
      const merged = { ...base, ...patch, state: { ...base.state, ...(patch.state as object) } }
      localStorage.setItem(key, JSON.stringify(merged))
    },
    { key: DRAFT_KEY, patch },
  )
}

async function openWizard(page: Page) {
  await page.goto('/streams/new', { waitUntil: 'networkidle' })
  await expect(page.locator('#wizard-stepper')).toBeVisible()
}

async function selectSavedConnector(page: Page) {
  await stepButton(page, 'Connect').click()
  const select = page.getByTestId('wizard-saved-connector-select')
  await expect(select).toBeVisible({ timeout: 20_000 })
  const dev = select.locator('option', { hasText: '[DEV VALIDATION]' }).first()
  if ((await dev.count()) > 0) {
    const value = await dev.getAttribute('value')
    if (value) await select.selectOption(value)
    else await select.selectOption({ index: 1 })
  } else {
    await select.selectOption({ index: 1 })
  }
  await expect(page.getByText('Inherited from connector (read-only)')).toBeVisible({ timeout: 20_000 })
}

function cloudTrailApiMock(statusCode: number, includeBody = true) {
  const rawBody = JSON.stringify(CLOUDTRAIL)
  return {
    ok: statusCode < 400,
    request: { method: 'GET', url: 'http://127.0.0.1/e2e/cloudtrail', headers_masked: {} },
    response: includeBody
      ? {
          status_code: statusCode,
          latency_ms: 5,
          headers: { 'content-type': 'application/json' },
          raw_body: rawBody,
          parsed_json: CLOUDTRAIL,
          content_type: 'application/json',
        }
      : {
          status_code: statusCode,
          latency_ms: 5,
          headers: {},
          raw_body: null,
          parsed_json: null,
          content_type: 'application/json',
        },
    analysis: includeBody
      ? {
          response_summary: {
            root_type: 'object',
            approx_size_bytes: rawBody.length,
            top_level_keys: ['ResponseMetadata', 'Records'],
            item_count_root: null,
            truncation: null,
          },
          detected_arrays: [{ path: '$.Records', count: 5, confidence: 0.98, reason: 'Array' }],
          detected_checkpoint_candidates: [
            {
              field_path: 'event.eventTime',
              checkpoint_type: 'TIMESTAMP',
              confidence: 0.9,
              sample_value: '2024-01-15T14:00:00Z',
              reason: 'event time',
            },
          ],
          sample_event: (CLOUDTRAIL.Records[0] as { event: Record<string, unknown> }).event,
          selected_event_array_default: '$.Records',
          flat_preview_fields: ['$.eventTime', '$.eventID'],
          preview_error: null,
        }
      : null,
  }
}

async function mockHttpApiTest(page: Page, statusCode: number, includeBody = true) {
  await page.route('**/api/v1/runtime/api-test/http', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cloudTrailApiMock(statusCode, includeBody)),
    })
  })
}

async function runApiTest(page: Page) {
  await stepButton(page, 'Sample').click()
  await page.getByTestId('wizard-sample-tab-run_test').click()
  const run = page.getByRole('button', { name: 'API Test', exact: true }).first()
  await expect(run).toBeEnabled({ timeout: 20_000 })
  const wait = page.waitForResponse(
    (res) => res.url().includes('/runtime/api-test/http') && res.request().method() === 'POST',
    { timeout: 60_000 },
  )
  await run.click()
  const response = await wait
  expect(response.ok()).toBeTruthy()
  await expect(
    page.getByText(/Response detected|API-backed|http_error|sample fetch did not succeed/i).first(),
  ).toBeVisible({ timeout: 15_000 })
}

async function confirmRecordPathAndCheckpoint(page: Page) {
  await page.getByTestId('wizard-sample-tab-record_selection').click()
  await expect(page.getByRole('heading', { name: 'Record Selection', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /\$\.Records · \d+ (records|events)/i }).first().click()
  for (const btn of await page.getByRole('button', { name: /^Sync position$/i }).all()) {
    await btn.click()
    const runtime = await page.getByTestId('summary-runtime').textContent()
    if (runtime?.includes('$')) break
  }
}

const MOCK_DESTINATION = {
  id: 1,
  name: 'Syslog Test',
  destination_type: 'SYSLOG_UDP',
  config_json: { host: '127.0.0.1', port: 514 },
  rate_limit_json: {},
  enabled: true,
  streams_using_count: 0,
  routes: [],
}

async function mockDestinationsList(page: Page) {
  await page.route('**/api/v1/destinations/**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([MOCK_DESTINATION]),
    })
  })
}

async function addDeliveryPathFromLibrary(page: Page) {
  await expect(page.getByText(MOCK_DESTINATION.name)).toBeVisible({ timeout: 20_000 })
  await page
    .locator('#wizard-destination-library')
    .getByRole('button', { name: 'Add delivery path' })
    .click()
  await expect(page.getByText(/Delivery paths \(1\)/i)).toBeVisible()
}

async function mockStreamCreateApi(page: Page, streamId: number, name: string) {
  await page.route('**/api/v1/streams/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/v1/streams/' && route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: streamId,
          name,
          connector_id: 1,
          source_id: 1,
          created_at: new Date().toISOString(),
        }),
      })
      return
    }
    await route.continue()
  })
}

async function mockWizardPostCreateApis(page: Page) {
  await page.route('**/api/v1/runtime/streams/*/mapping-ui/save', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.route('**/api/v1/routes/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/v1/routes/' && route.request().method() === 'POST') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 88001 }) })
      return
    }
    await route.continue()
  })
}

async function mockDataProtectionRuleApis(
  page: Page,
  collectors: { policyRules: unknown[]; classificationRules: unknown[] },
) {
  await page.route('**/api/v1/runtime/streams/*/policy-rules**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      collectors.policyRules.push(body)
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ rule: { id: collectors.policyRules.length, ...body } }),
      })
      return
    }
    await route.continue()
  })
  await page.route('**/api/v1/runtime/streams/*/classification-rules**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      collectors.classificationRules.push(body)
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ rule: { id: collectors.classificationRules.length, ...body } }),
      })
      return
    }
    await route.continue()
  })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
})

test.beforeEach(async ({ page, request }) => {
  await signInForValidation(page, request)
})

test('01 /streams/new opens empty by default', async ({ page }) => {
  await clearDraft(page)
  await openWizard(page)
  await expect(page.getByTestId('wizard-draft-banner')).toHaveCount(0)
  await expect(page.getByText('Draft restored from local storage.')).toHaveCount(0)
  const select = page.getByTestId('wizard-saved-connector-select')
  await expect(select).toHaveValue('')
  await shot(page, '01-empty-default')
})

test('02 existing draft shows Resume / Start fresh banner', async ({ page }) => {
  await seedDraft(page, {
    stepKey: 'sample',
    state: {
      connector: { connectorId: 99, sourceId: 1, connectorName: 'Draft Connector' },
      stream: { name: 'Saved Draft Stream', endpoint: '/events' },
    },
  })
  await openWizard(page)
  await expect(page.getByTestId('wizard-draft-banner')).toBeVisible()
  await expect(page.getByText('Saved draft found.')).toBeVisible()
  await expect(page.getByTestId('wizard-draft-resume')).toBeVisible()
  await expect(page.getByTestId('wizard-draft-start-fresh')).toBeVisible()
  await shot(page, '02-draft-banner')
})

test('03 Start fresh clears draft', async ({ page }) => {
  await seedDraft(page, { stepKey: 'connect' })
  await openWizard(page)
  await page.getByTestId('wizard-draft-start-fresh').click()
  const raw = await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)
  expect(raw).toBeNull()
  await expect(page.getByTestId('wizard-step-connect')).toBeVisible()
  await expect(page.getByTestId('wizard-draft-banner')).toHaveCount(0)
  await shot(page, '03-start-fresh')
})

test('04 Resume draft restores correctly', async ({ page }) => {
  await seedDraft(page, {
    stepKey: 'sample',
    state: {
      connector: { connectorId: 77, sourceId: 1, connectorName: 'Restored Connector' },
      stream: { name: 'Restored Stream', endpoint: '/events' },
      apiTest: { status: 'success', ok: true, parsedJson: CLOUDTRAIL, finishedAt: Date.now() },
    },
  })
  await openWizard(page)
  await page.getByTestId('wizard-draft-resume').click()
  await expect(page.getByText('Draft restored from local storage.')).toBeVisible()
  await expect(page.getByTestId('wizard-step-sample')).toBeVisible()
  await shot(page, '04-resume-draft')
})

test('05 API Test success blocks Sample until manual Record Path + Sync Position confirmation', async ({ page }) => {
  await clearDraft(page)
  await openWizard(page)
  await selectSavedConnector(page)
  await mockHttpApiTest(page, 200)
  await runApiTest(page)
  await page.getByTestId('wizard-sample-tab-record_selection').click()
  await expect(page.getByRole('button', { name: /Next: Transform/i })).toBeDisabled()
  await shot(page, '05-before-confirmation')
  await confirmRecordPathAndCheckpoint(page)
  await expect(page.getByRole('button', { name: /Next: Transform/i })).toBeEnabled()
  await shot(page, '05-after-confirmation')
})

test('06 API Test failure blocks Transform', async ({ page }) => {
  await clearDraft(page)
  await openWizard(page)
  await selectSavedConnector(page)
  await mockHttpApiTest(page, 200)
  await runApiTest(page)
  await confirmRecordPathAndCheckpoint(page)
  await expect(page.getByRole('button', { name: /Next: Transform/i })).toBeEnabled()
  await mockHttpApiTest(page, 503, false)
  await page.getByTestId('wizard-sample-tab-run_test').click()
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText(/HTTP 503|http_error|sample fetch did not succeed|API test failed/i).first()).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByRole('button', { name: /Next: Transform/i })).toBeDisabled()
  await expect(stepButton(page, 'Transform')).toBeDisabled()
  await shot(page, '06-api-failure-blocks-transform')
})

test('07 HTTP 400/500 blocks Transform', async ({ page }) => {
  await clearDraft(page)
  await openWizard(page)
  await selectSavedConnector(page)
  await mockHttpApiTest(page, 500)
  await runApiTest(page)
  await page.getByTestId('wizard-sample-tab-record_selection').click()
  await confirmRecordPathAndCheckpoint(page)
  await expect(page.getByRole('button', { name: /Next: Transform/i })).toBeDisabled()
  await expect(stepButton(page, 'Transform')).toBeDisabled()
  await shot(page, '07-http-500-blocks-transform')
})

test('08 Deploy create blocked after latest API Test failure', async ({ page }) => {
  const finishedAt = Date.now()
  await seedDraft(page, {
    stepKey: 'deploy',
    state: {
      connector: { connectorId: 1, sourceId: 1, connectorName: 'DEV', sourceType: 'HTTP_API_POLLING' },
      stream: {
        name: 'Deploy Block Test',
        endpoint: '/events',
        eventArrayPath: '$.Records',
        checkpointSourcePath: '$.eventTime',
        recordPathConfirmedForApiTestAt: finishedAt - 1,
        checkpointConfirmedForApiTestAt: finishedAt - 1,
      },
      apiTest: {
        status: 'error',
        ok: false,
        parsedJson: CLOUDTRAIL,
        finishedAt,
        errorMessage: 'Latest API test failed',
      },
      mapping: [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.eventID' }],
      destinations: {
        routeDrafts: [{ key: 'r1', destinationId: 1, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} }],
        destinationApiBacked: true,
      },
    },
  })
  await openWizard(page)
  await page.getByTestId('wizard-draft-resume').click()
  await expect(page.getByTestId('wizard-step-deploy')).toBeVisible()
  await expect(page.getByTestId('deploy-create-and-start')).toBeDisabled()
  await shot(page, '08-deploy-blocked-after-api-failure')
})

test('09 successful full wizard path creates stream', async ({ page }) => {
  await clearDraft(page)
  await openWizard(page)
  await selectSavedConnector(page)
  await mockHttpApiTest(page, 200)

  await mockDestinationsList(page)
  await mockStreamCreateApi(page, 91001, 'Manual Validation Stream')
  await mockWizardPostCreateApis(page)

  await runApiTest(page)
  await confirmRecordPathAndCheckpoint(page)
  await stepButton(page, 'Transform').click()
  await page.getByTestId('wizard-transform-section-output_fields').click()
  await page.getByRole('button', { name: 'Add row' }).click()
  const mappingRow = page.locator('table tbody tr').last()
  await mappingRow.getByLabel('Source JSONPath').fill('$.eventID')
  await mappingRow.locator('td').nth(3).getByRole('textbox').fill('event_id')
  await stepButton(page, 'Destinations').click()
  await addDeliveryPathFromLibrary(page)
  await page.getByRole('button', { name: /Next: Deploy/i }).click()
  await expect(page.getByTestId('deploy-create-and-start')).toBeEnabled({ timeout: 15_000 })
  const createPromise = page.waitForResponse(
    (res) => {
      const url = new URL(res.url())
      return url.pathname === '/api/v1/streams/' && res.request().method() === 'POST'
    },
    { timeout: 30_000 },
  )
  await page.getByTestId('deploy-create-and-start').click()
  const createResp = await createPromise
  expect(createResp.status()).toBe(201)
  const created = (await createResp.json()) as { id: number }
  expect(created.id).toBe(91001)
  await expect(page.getByRole('button', { name: /Create Another Stream/i })).toBeVisible({ timeout: 30_000 })
  await shot(page, '09-stream-created')
})

test('10 Data Protection intent persists policy/classification rules', async ({ page }) => {
  await clearDraft(page)
  await openWizard(page)
  await selectSavedConnector(page)
  await mockHttpApiTest(page, 200)

  const streamId = 92002
  const policyRules: unknown[] = []
  const classificationRules: unknown[] = []

  await mockDestinationsList(page)
  await mockStreamCreateApi(page, streamId, 'Protection Stream')
  await mockWizardPostCreateApis(page)
  await mockDataProtectionRuleApis(page, { policyRules, classificationRules })

  await runApiTest(page)
  await confirmRecordPathAndCheckpoint(page)
  await stepButton(page, 'Transform').click()
  await page.getByTestId('wizard-transform-section-output_fields').click()
  await page.getByRole('button', { name: 'Add row' }).click()
  const mappingRow = page.locator('table tbody tr').last()
  await mappingRow.getByLabel('Source JSONPath').fill('$.eventID')
  await mappingRow.locator('td').nth(3).getByRole('textbox').fill('event_id')

  await stepButton(page, 'Data Protection').click()
  await page.getByTestId('data-protection-add-row').click()
  await page.getByTestId(/data-protection-row-/).getByLabel('Detected field').fill('$.user.email')
  await stepButton(page, 'Destinations').click()
  await addDeliveryPathFromLibrary(page)
  await page.getByRole('button', { name: /Next: Deploy/i }).click()
  await expect(page.getByTestId('deploy-create-and-start')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('deploy-create-and-start').click()
  await expect(page.getByRole('button', { name: /Create Another Stream/i })).toBeVisible({ timeout: 30_000 })

  expect(policyRules.length).toBeGreaterThan(0)
  expect(classificationRules.length).toBeGreaterThan(0)
  await shot(page, '10-data-protection-persisted')
})
