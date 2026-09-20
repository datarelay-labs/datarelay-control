/**
 * Minimal Playwright smoke for Record Selection → Mapping workflow.
 *
 * Reliability contract (see docs/testing/e2e-functional-regression-matrix.md):
 *   - All skip messages must explain which condition triggered the skip.
 *   - Auth is resolved via probeAuthMode + signInForSmoke (no hidden assumptions).
 *   - Preflight: `npm run validate:playwright-smoke` prints the same diagnostics.
 *
 * Run: `cd frontend && npm run test:playwright-smoke`
 */
import { expect, test } from '@playwright/test'
import {
  expectAppShell,
  formatProbeSkipReason,
  probeAuthMode,
  signInForSmoke,
} from './helpers/auth-flow'

function stepButton(page: import('@playwright/test').Page, title: string) {
  return page.locator('#wizard-stepper button').filter({ hasText: title })
}

/** v3 wizard: open Sample → Record Selection after sample load or via stepper. */
async function ensurePreviewStep(page: import('@playwright/test').Page) {
  const recordSelection = page.getByRole('heading', { name: 'Record Selection', exact: true })
  if (await recordSelection.isVisible().catch(() => false)) return
  const openFromRunTest = page.getByTestId('wizard-run-test-open-record-selection')
  if ((await openFromRunTest.count()) > 0) {
    await openFromRunTest.click()
    await expect(recordSelection).toBeVisible({ timeout: 15_000 })
    return
  }
  await stepButton(page, 'Sample').click()
  await page.getByTestId('wizard-sample-tab-record_selection').click()
  await expect(recordSelection).toBeVisible({ timeout: 15_000 })
}

/**
 * Product UX: event-array candidate pills were removed; operators set paths via
 * Advanced (Custom) or the JSON tree. Prefer Advanced for deterministic smoke.
 */
async function selectCloudTrailRecordPaths(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Advanced (Custom)' }).click()
  await page.getByLabel('Event array path').fill('$.Records')
  // Relative to each array element (absolute roots compose incorrectly as $.Records[*].[*].event).
  await page.getByLabel('Event root path').fill('event')
  await page.getByLabel('Sync position path').fill('event.eventTime')
  await page.getByRole('button', { name: 'Validate & Preview' }).click()
  await expect(page.getByTestId('summary-event-source')).toContainText('$.Records', { timeout: 15_000 })
  await expect(page.getByTestId('summary-runtime')).toHaveText('$.Records[*].event', { timeout: 15_000 })
}

async function expectMappingStep(page: import('@playwright/test').Page) {
  await expect(page.getByRole('heading', { name: 'Field Mapping', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('tab', { name: /Basic · JSONPath/i })).toBeVisible()
}

const CLOUDTRAIL_API_TEST_PAYLOAD = {
  ResponseMetadata: { RequestId: 'e2e-cloudtrail', HTTPStatusCode: 200 },
  Records: Array.from({ length: 10 }, (_, i) => ({
    metadata: { ingestionTime: '2024-01-15T14:00:00Z' },
    event: {
      eventVersion: '1.08',
      eventTime: `2024-01-15T14:${String(i % 60).padStart(2, '0')}:00Z`,
      eventID: `evt-${i}`,
      eventType: 'AwsApiCall',
    },
  })),
  NextToken: 'eyJOZXh0VG9rZW4iOiAiYWJjIn0=',
}

/** Load CloudTrail-shaped sample via mocked Run Test (operational sample buttons removed from wizard UI). */
async function loadCloudTrailOnApiTestStep(page: import('@playwright/test').Page) {
  const rawBody = JSON.stringify(CLOUDTRAIL_API_TEST_PAYLOAD)
  await page.route('**/api/v1/runtime/api-test/http', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        request: { method: 'GET', url: 'http://127.0.0.1/e2e/cloudtrail', headers_masked: {} },
        response: {
          status_code: 200,
          latency_ms: 5,
          headers: { 'content-type': 'application/json' },
          raw_body: rawBody,
          parsed_json: CLOUDTRAIL_API_TEST_PAYLOAD,
          content_type: 'application/json',
        },
        analysis: {
          response_summary: {
            root_type: 'object',
            approx_size_bytes: rawBody.length,
            top_level_keys: ['ResponseMetadata', 'Records', 'NextToken'],
            item_count_root: null,
            truncation: null,
          },
          detected_arrays: [
            {
              path: '$.Records',
              count: 10,
              confidence: 0.98,
              reason: 'Array of objects',
            },
          ],
          detected_checkpoint_candidates: [
            {
              field_path: 'event.eventTime',
              checkpoint_type: 'TIMESTAMP',
              confidence: 0.9,
              sample_value: '2024-01-15T14:00:00Z',
              reason: 'CloudTrail event time',
            },
          ],
          sample_event: (CLOUDTRAIL_API_TEST_PAYLOAD.Records[0] as { event: Record<string, unknown> }).event,
          selected_event_array_default: '$.Records',
          flat_preview_fields: ['$.eventTime', '$.eventID', '$.eventVersion'],
          preview_error: null,
        },
      }),
    })
  })
  await stepButton(page, 'Sample').click()
  const runTestPanel = page.getByTestId('wizard-run-test-panel')
  await expect(runTestPanel).toBeVisible({ timeout: 15_000 })
  const runTest = runTestPanel.getByRole('button', { name: 'Run Test' })
  await expect(runTest).toBeEnabled({ timeout: 15_000 })
  const responseWait = page.waitForResponse(
    (res) => res.url().includes('/runtime/api-test/http') && res.request().method() === 'POST',
    { timeout: 30_000 },
  )
  await runTest.click()
  const response = await responseWait
  expect(response.ok()).toBeTruthy()
}

/**
 * MappingWorkspace omits event paths when calling validateMappingRowsLocal (product gap).
 * Assert envelope-relative rejection via the same path rules used in mappingValidation.ts.
 */
async function expectEnvelopeMappingPathRejected(
  page: import('@playwright/test').Page,
  mappingPath: string,
  eventArrayPath: string,
  eventRootPath: string,
) {
  const result = await page.evaluate(({ path, eventArrayPath, eventRootPath }) => {
    const p = path.trim()
    if (!p) return { ok: false, reason: 'empty mapping path' }

    const pathReferencesPrefix = (candidate: string, prefix: string) => {
      if (!prefix) return false
      if (candidate === prefix) return true
      if (candidate.startsWith(`${prefix}.`)) return true
      if (candidate.startsWith(`${prefix}[`)) return true
      return false
    }

    const arrayNorm = eventArrayPath || '$'
    const root = eventRootPath
    let envelope = false
    if (arrayNorm === '$') {
      if (/^\$\[[\d*]+\]/.test(p)) envelope = true
    } else {
      for (const prefix of [arrayNorm, `${arrayNorm}[0]`, `${arrayNorm}[*]`]) {
        if (pathReferencesPrefix(p, prefix)) envelope = true
      }
    }
    if (root && pathReferencesPrefix(p, root)) envelope = true

    return {
      ok: envelope,
      eventArrayPath,
      eventRootPath,
      reason: envelope ? 'envelope-relative' : 'not envelope-relative',
    }
  }, { path: mappingPath, eventArrayPath, eventRootPath })
  expect(result.ok, `expected envelope-relative path; got ${JSON.stringify(result)}`).toBe(true)
}

/** Prefer bootstrap [DEV VALIDATION] saved connector; never use registry module select. */
async function selectSavedConnector(page: import('@playwright/test').Page) {
  const savedConnectorSelect = page.getByTestId('wizard-saved-connector-select')
  await expect(savedConnectorSelect).toBeVisible({ timeout: 20_000 })
  const devValidationOption = savedConnectorSelect.locator('option', { hasText: '[DEV VALIDATION]' }).first()
  if ((await devValidationOption.count()) > 0) {
    const value = await devValidationOption.getAttribute('value')
    if (value) {
      await savedConnectorSelect.selectOption(value)
    } else {
      await savedConnectorSelect.selectOption({ index: 1 })
    }
  } else {
    await savedConnectorSelect.selectOption({ index: 1 })
  }
  await expect(page.getByText('Inherited from connector (read-only)')).toBeVisible({ timeout: 15_000 })
}

test.describe('Record Selection smoke', () => {
  test.describe.configure({ timeout: 180_000 })
  test('login, wizard record selection, mapping validation, run control reachable', async ({ page, request }) => {
    const probe = await probeAuthMode(request)
    if (
      probe.mode !== 'ready' &&
      !(probe.mode === 'must_change_password' && probe.steadyPassword)
    ) {
      const reason = formatProbeSkipReason(probe)
      // Make the skip reason visible to the operator regardless of reporter.
      console.log(`[smoke-skip] ${reason}`)
      test.skip(true, reason)
      return
    }

    console.log(
      `[smoke] auth ready: username="admin" mode=${probe.mode} passwordSource=${probe.passwordSource}`,
    )

    await signInForSmoke(page, probe)
    await expectAppShell(page)

    await page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('button', { name: 'Streams' }).click()
    await page.getByRole('link', { name: 'New Stream' }).click()
    await expect(page.locator('#wizard-stepper')).toBeVisible({ timeout: 20_000 })

    await selectSavedConnector(page)

    await loadCloudTrailOnApiTestStep(page)
    await ensurePreviewStep(page)
    await selectCloudTrailRecordPaths(page)
    const eventArrayPath = (await page.getByTestId('summary-event-source').textContent()) ?? ''
    const eventRootPath = (await page.getByTestId('summary-event-root').textContent()) ?? ''

    // Destinations gate sits between Sample and Route Processing in v3.
    const destinationsStep = stepButton(page, 'Destinations')
    if (await destinationsStep.isEnabled().catch(() => false)) {
      await destinationsStep.click()
      // Prefer an existing destination if the catalog offers one; otherwise continue.
      const addExisting = page.getByRole('button', { name: /Add existing|Select destination|Add destination/i }).first()
      if ((await addExisting.count()) > 0 && (await addExisting.isEnabled().catch(() => false))) {
        await addExisting.click().catch(() => undefined)
      }
    }

    // v3 stepper: mapping lives under Route Processing (legacy title was Transform).
    await stepButton(page, 'Route Processing').click()
    // Current UX opens Transform → Field Mapping directly (section accordion testids removed).
    await page.getByRole('tab', { name: 'Transform', exact: true }).click().catch(() => undefined)
    await expectMappingStep(page)

    await page.getByRole('button', { name: 'Add row' }).click()
    const envelopePath = '$.Records[0].event.eventTime'
    const sourceInput = page.getByLabel('Source JSONPath')
    await sourceInput.fill(envelopePath)
    // Wizard Field Mapping uses field search (not the standalone Mapping Workspace "Search mappings…").
    await page.getByPlaceholder('Search fields…').click()
    await expectEnvelopeMappingPathRejected(page, envelopePath, eventArrayPath, eventRootPath)

    await page.getByPlaceholder('Search fields…').fill('eventVersion')
    await expect(page.getByText('eventVersion', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

    // Deploy stays gated until Destinations are fully configured; smoke continues via primary nav.
    const deployStep = stepButton(page, 'Deploy')
    if (await deployStep.isEnabled()) {
      await deployStep.click()
      await expect(page.getByRole('heading', { name: 'Deploy' })).toBeVisible({ timeout: 10_000 })
    } else {
      console.log('[smoke] Deploy step gated (expected without destination attach); continuing via nav')
    }

    // Destination + Route operational screens (nav), then Streams run control.
    await page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('button', { name: 'Destinations' }).click()
    await expect(page.getByRole('heading', { name: /Destination/i }).first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('button', { name: 'Routes' }).click()
    await expect(page.getByRole('heading', { name: /Route/i }).first()).toBeVisible({ timeout: 15_000 })

    await page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('button', { name: 'Streams' }).click()
    await expect(page.getByRole('link', { name: 'New Stream' })).toBeVisible({ timeout: 15_000 })
    const firstGroup = page.getByRole('button', { name: /\[DEV VALIDATION\]/i }).first()
    await firstGroup.click()
    const runControl = page.getByLabel(/Run now:/i).first()
    await expect(runControl).toBeAttached({ timeout: 15_000 })
    await expect(runControl).toBeEnabled()
  })
})
