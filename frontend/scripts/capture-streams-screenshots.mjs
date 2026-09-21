import { chromium } from 'playwright'
import path from 'node:path'

const baseUrl = process.env.GDC_SCREENSHOT_BASE_URL || 'http://localhost:18443'
const outDir = process.env.GDC_SCREENSHOT_OUT_DIR || path.resolve('..', 'docs/ux/screenshots-mockup-impl')

const mockSession = {
  access_token: 'screenshot-mock-token',
  refresh_token: 'screenshot-mock-refresh',
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  user: {
    username: 'admin',
    role: 'ADMINISTRATOR',
    status: 'active',
    must_change_password: false,
    capabilities: {
      runtime_stream_control: true,
      workspace_mutations: true,
      backfill_mutations: true,
      backup_clone: true,
    },
  },
}

const streamsFixture = [
  { id: 1, name: 'e2e-stream-a', connector_id: 10, status: 'RUNNING', stream_type: 'HTTP_API_POLLING', created_at: '2026-05-01T10:00:00Z', polling_interval: 60 },
  { id: 2, name: 'e2e-stream-b', connector_id: 10, status: 'DEGRADED', stream_type: 'HTTP_API_POLLING', created_at: '2026-05-02T10:00:00Z', polling_interval: 60 },
  { id: 3, name: 'cs-falcon-ingest', connector_id: 11, status: 'RUNNING', stream_type: 'HTTP_API_POLLING', created_at: '2026-05-03T10:00:00Z', polling_interval: 120 },
]

async function mockApis(page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/auth/login') || url.includes('/auth/refresh')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockSession) })
    }
    if (url.includes('/streams') && !url.match(/\/streams\/\d+/)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(streamsFixture) })
    }
    if (url.includes('/connectors/10')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 10, name: 'e2e-connector', product_group: 'e2e-connector' }) })
    }
    if (url.includes('/connectors/11')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 11, name: 'CrowdStrike Falcon', product_group: 'CrowdStrike' }) })
    }
    if (url.includes('/runtime/dashboard/summary')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          summary: { total_streams: 3, running_streams: 2, error_streams: 0, stopped_streams: 0, rate_limited_source_streams: 1, rate_limited_destination_streams: 0, paused_streams: 0, processed_events: 1200, delivery_outcome_events: 1100 },
        }),
      })
    }
    if (url.includes('/runtime/streams/1/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          stream_status: 'RUNNING',
          summary: { processed_events: 120, route_send_success: 110, route_send_failed: 2, route_retry_success: 5, route_retry_failed: 1 },
          last_seen: { success_at: new Date(Date.now() - 120000).toISOString() },
          routes: [{ counts: { route_send_success: 10, route_send_failed: 0, route_retry_success: 0, route_retry_failed: 0 } }],
        }),
      })
    }
    if (url.includes('/runtime/streams/1/metrics')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          stream: { id: 1, name: 'e2e-stream-a', status: 'RUNNING', last_run_at: new Date(Date.now() - 120000).toISOString(), last_checkpoint: { type: 'cursor', value: { offset: 42 } } },
          kpis: { events_last_hour: 120, delivered_last_hour: 110, failed_last_hour: 2, delivery_success_rate: 91.6, error_rate: 1.2 },
          events_over_time: [],
          route_health: [],
          checkpoint_history: [],
          recent_runs: [],
          route_runtime: [],
          recent_route_errors: [{ message: 'Destination returned HTTP 429', created_at: new Date().toISOString() }],
        }),
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
}

async function seedSession(page) {
  await page.addInitScript((session) => {
    localStorage.setItem('gdc_platform_session_v1', JSON.stringify(session))
  }, mockSession)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await mockApis(page)
  await seedSession(page)

  await page.goto(`${baseUrl}/streams`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForSelector('[data-testid="streams-health-overview"]', { timeout: 60000 })
  const groupRow = page.locator('[data-testid^="stream-group-row-"]').first()
  if (await groupRow.count()) {
    await groupRow.click()
    await page.waitForSelector('[data-testid^="stream-group-child-row-"]', { timeout: 10000 }).catch(() => {})
  }
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(outDir, 'after-streams-expanded.png'), fullPage: true })

  await page.goto(`${baseUrl}/streams/1/runtime`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForSelector('[data-testid="stream-monitoring-status-strip"]', { timeout: 60000 })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: path.join(outDir, 'after-stream-monitoring.png'), fullPage: true })

  await browser.close()
  console.log(`Screenshots saved to ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
