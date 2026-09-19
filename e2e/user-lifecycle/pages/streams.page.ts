import type { Page } from '@playwright/test'
import { TIMEOUTS } from '../helpers/types.js'
import type { OperatorSession } from './session.js'

const SHORT = TIMEOUTS.shortMs
const ACTION = TIMEOUTS.actionMs

export class DestinationsPage {
  constructor(readonly session: OperatorSession) {}

  get page(): Page {
    return this.session.page
  }

  async openList(): Promise<void> {
    await this.session.goto('/destinations', 'destinations-list')
    await this.page.getByRole('button', { name: /New Destination/i }).first().waitFor({ timeout: SHORT }).catch(() => null)
  }

  async openCreate(): Promise<void> {
    await this.openList()
    this.session.artifacts.action('open-destination-create', '/destinations', 'New')
    const byTestId = this.page.getByTestId('destinations-new')
    const byRole = this.page.getByRole('button', { name: /New Destination/i }).first()
    if (await byTestId.count()) {
      await byTestId.click({ timeout: ACTION })
    } else {
      await byRole.click({ timeout: ACTION })
    }
    await this.page.getByRole('dialog').waitFor({ timeout: SHORT }).catch(() => null)
    await this.page.getByTestId('destination-form-dialog').waitFor({ timeout: SHORT }).catch(() => null)
  }

  async fillWebhookDestination(opts: { name: string; url: string }): Promise<void> {
    this.session.artifacts.action('fill-destination', '/destinations', opts.name)
    const name = this.page.getByLabel(/^Name/i).first()
    await name.fill(opts.name, { timeout: SHORT })
    const type = this.page.locator('form#dest-form select').first()
    if (await type.count()) {
      await type.selectOption('WEBHOOK_POST', { timeout: SHORT }).catch(() => null)
    }
    const url = this.page.getByLabel(/^URL/i).first()
    await url.fill(opts.url, { timeout: SHORT })
  }

  async save(): Promise<void> {
    this.session.artifacts.action('save-destination', '/destinations', 'Save')
    const btn = this.page.locator('form#dest-form').getByRole('button', { name: /Save|Create|Add Destination/i }).last()
    if (await btn.count()) await btn.click({ timeout: SHORT })
    else await this.page.getByRole('button', { name: /Save|Create/i }).last().click({ timeout: SHORT })
    await this.page.waitForTimeout(800)
  }

  async tryInvalidEmptyName(): Promise<{ blockedOrError: boolean; message: string }> {
    await this.openCreate()
    this.session.artifacts.action('invalid-destination-empty-name', '/destinations', '')
    const type = this.page.locator('form#dest-form select').first()
    if (await type.count()) await type.selectOption('WEBHOOK_POST', { timeout: SHORT }).catch(() => null)
    const name = this.page.getByLabel(/^Name/i).first()
    if (await name.count()) await name.fill('', { timeout: SHORT })
    const url = this.page.getByLabel(/^URL/i).first()
    if (await url.count()) await url.fill('http://127.0.0.1:9/invalid', { timeout: SHORT })
    await this.save()
    await this.page.waitForTimeout(600)
    const msg =
      (await this.page.getByTestId('destination-form-error').innerText().catch(() => '')) ||
      (await this.page.getByRole('alert').first().innerText().catch(() => '')) ||
      (await this.page.locator('[data-testid*="error"], .text-red-600, .text-red-100').first().innerText().catch(() => ''))
    const stillOpen = await this.page.locator('form#dest-form').isVisible().catch(() => false)
    const bad = /500|Internal Server Error/i.test(msg)
    return { blockedOrError: stillOpen || (!!msg && !bad), message: msg.slice(0, 500) }
  }

  async tryInvalidUrl(name: string): Promise<{ okUi: boolean; message: string }> {
    await this.openCreate()
    await this.fillWebhookDestination({ name, url: 'not-a-url' })
    await this.save()
    await this.page.waitForTimeout(600)
    const msg =
      (await this.page.getByTestId('destination-form-error').innerText().catch(() => '')) ||
      (await this.page.getByRole('alert').first().innerText().catch(() => '')) ||
      (await this.page.locator('[data-testid*="error"], .text-red-600, .text-red-100').first().innerText().catch(() => ''))
    const stillOpen = await this.page.locator('form#dest-form').isVisible().catch(() => false)
    const actionable = /http:\/\/|https:\/\/|host|scheme|url/i.test(msg)
    const bad = /500|Internal Server Error/i.test(msg) || !msg
    return { okUi: !bad && !!msg && actionable && stillOpen, message: msg.slice(0, 500) }
  }

  lastEditMeta: { putStatus: number | null; formError: string; formClosed: boolean } = {
    putStatus: null,
    formError: '',
    formClosed: false,
  }

  async editWebhookUrl(name: string, url: string): Promise<boolean> {
    await this.openList()
    this.session.artifacts.action('edit-destination-url', '/destinations', name)
    const search = this.page.getByPlaceholder(/Search destinations/i)
    if (await search.count()) {
      await search.fill(name)
      await this.page.waitForTimeout(300)
    }
    const short = name.length > 24 ? name.slice(-24) : name
    const row = this.page
      .locator('table tbody tr')
      .filter({ hasText: short })
      .first()
    if (!(await row.count())) return false
    await row.click({ timeout: ACTION }).catch(() => null)
    await this.page.waitForTimeout(400)
    let opened = await this.page.locator('form#dest-form').isVisible().catch(() => false)
    if (!opened) {
      const editDest = this.page.getByRole('button', { name: /Edit Destination/i }).first()
      if (await editDest.count()) {
        await editDest.click({ timeout: ACTION }).catch(() => null)
        await this.page.locator('form#dest-form').waitFor({ timeout: SHORT }).catch(() => null)
        opened = await this.page.locator('form#dest-form').isVisible().catch(() => false)
      }
    }
    if (!opened) {
      const kebab = row.locator('button').filter({ has: this.page.locator('svg') }).last()
      if (await kebab.count()) await kebab.click({ timeout: ACTION }).catch(() => null)
      const edit = this.page.getByRole('button', { name: /^Edit$/i }).first()
      if (!(await edit.count()) || (await edit.isDisabled().catch(() => false))) return false
      await edit.click({ timeout: ACTION })
      await this.page.locator('form#dest-form').waitFor({ timeout: SHORT }).catch(() => null)
    }
    if (!opened) {
      await this.session.screenshotOnFail('dest-edit-miss')
      return false
    }
    const urlField = this.page.getByLabel(/^URL/i).first()
    if (!(await urlField.count())) return false
    await urlField.fill(url, { timeout: SHORT })
    const putWait = this.page
      .waitForResponse(
        (r) => r.request().method() === 'PUT' && /\/api\/v1\/destinations\/\d+/.test(r.url()),
        { timeout: ACTION },
      )
      .catch(() => null)
    await this.save()
    const put = await putWait
    await this.page.waitForTimeout(600)
    const formError =
      (await this.page.getByTestId('destination-form-error').innerText().catch(() => '')) || ''
    const formOpen = await this.page.locator('form#dest-form').isVisible().catch(() => false)
    this.lastEditMeta = {
      putStatus: put ? put.status() : null,
      formError: formError.slice(0, 300),
      formClosed: !formOpen,
    }
    this.session.artifacts.action(
      'edit-destination-put',
      '/destinations',
      `status=${this.lastEditMeta.putStatus} closed=${this.lastEditMeta.formClosed}`,
    )
    // List UI does not render webhook URL text — persist is PUT 2xx + sheet close.
    return this.lastEditMeta.putStatus !== null && this.lastEditMeta.putStatus < 300 && this.lastEditMeta.formClosed
  }
}

export class StreamsPage {
  constructor(readonly session: OperatorSession) {}

  get page(): Page {
    return this.session.page
  }

  async openList(): Promise<void> {
    await this.session.goto('/streams', 'streams-list')
    await this.page.getByTestId('streams-operations-toolbar').waitFor({ timeout: SHORT }).catch(() => null)
  }

  async openDashboard(): Promise<void> {
    // Canonical operator dashboard is /monitoring (NAV_PATH.dashboard). /dashboard is not a route.
    await this.session.goto('/monitoring', 'dashboard')
    await this.page.getByTestId('dashboard-operational-issues').waitFor({ timeout: ACTION }).catch(() => null)
  }

  async openMonitoring(): Promise<void> {
    await this.session.goto('/monitoring', 'monitoring')
  }

  async search(q: string): Promise<void> {
    const input = this.page.getByTestId('streams-search-input')
    if (await input.count()) await input.fill(q)
  }

  async openRuntime(id: number): Promise<void> {
    this.session.artifacts.action('open-stream-runtime', `/streams/${id}/runtime`, `id=${id}`)
    await this.session.goto(`/streams/${id}/runtime`, 'stream-runtime')
    await this.page.waitForTimeout(600)
  }

  async expandVisibleStreamGroups(): Promise<void> {
    const groups = this.page.locator('[data-testid^="stream-group-row-"]')
    const n = await groups.count()
    for (let i = 0; i < n; i++) {
      const group = groups.nth(i)
      const expanded = await group.getAttribute('aria-expanded')
      if (expanded !== 'true') {
        await group.click({ timeout: SHORT }).catch(() => null)
        await this.page.waitForTimeout(250)
      }
    }
  }

  async openStreamByName(name: string): Promise<boolean> {
    await this.openList()
    await this.search(name)
    this.session.artifacts.action('open-stream', '/streams', name)
    await this.expandVisibleStreamGroups()
    const short = name.length > 24 ? name.slice(-24) : name
    const row = this.page.locator(`[data-testid^="stream-group-child-row-"]`, { hasText: short }).first()
    await row.waitFor({ timeout: ACTION }).catch(() => null)
    if (await row.count()) {
      await row.click({ timeout: SHORT })
      await this.page.waitForTimeout(600)
      return true
    }
    const text = this.page.getByText(short, { exact: false }).first()
    if (await text.count()) {
      await text.click({ timeout: SHORT }).catch(() => null)
      await this.page.waitForTimeout(600)
      return /\/streams\/\d+/.test(this.page.url())
    }
    this.session.artifacts.action('open-stream-miss', '/streams', name)
    return false
  }

  async readDashboardProblemSignal(): Promise<{
    visible: boolean
    posture: string
    issuesText: string
    problemCount: number
  }> {
    await this.page.getByTestId('dashboard-operational-issues').waitFor({ timeout: SHORT }).catch(() => null)
    const posture =
      (await this.page.getByTestId('dashboard-overall-posture-label').textContent({ timeout: 3000 }).catch(() => null)) ||
      (await this.page.getByTestId('dashboard-beacon-label').textContent({ timeout: 1000 }).catch(() => null)) ||
      ''
    const issuesText = (await this.page.getByTestId('dashboard-operational-issues').innerText().catch(() => '')) || ''
    const problemCount = await this.page.locator('[data-testid^="dashboard-problem-"]').count()
    const warnCountText = (await this.page.getByTestId('dashboard-health-warning').innerText().catch(() => '')) || ''
    const critCountText = (await this.page.getByTestId('dashboard-health-critical').innerText().catch(() => '')) || ''
    const countHit = /\b[1-9]\d*\b/.test(warnCountText) || /\b[1-9]\d*\b/.test(critCountText)
    const visible =
      problemCount > 0 ||
      countHit ||
      /warning|critical/i.test(posture) ||
      (/operational issues/i.test(issuesText) && !/no operational issues/i.test(issuesText))
    return { visible, posture: posture.trim(), issuesText: issuesText.slice(0, 800), problemCount }
  }

  async diagnoseFailureJourney(): Promise<{
    ERROR_VISIBLE: 'YES' | 'NO'
    AFFECTED_RESOURCE_IDENTIFIABLE: 'YES' | 'NO'
    ROOT_CAUSE_VISIBLE: 'YES' | 'NO'
    RECOVERY_ACTION_VISIBLE: 'YES' | 'NO'
    pagesVisited: string[]
  }> {
    const pagesVisited: string[] = []
    await this.openDashboard()
    pagesVisited.push('dashboard')
    const dashSignal = await this.readDashboardProblemSignal()
    const dash = `${dashSignal.posture}\n${dashSignal.issuesText}`
    await this.openList()
    pagesVisited.push('streams')
    const listSnippet = (await this.page.getByTestId('streams-operations-toolbar').innerText().catch(() => '')) || ''
    await this.openMonitoring()
    pagesVisited.push('monitoring')
    const monSnippet =
      (await this.page.getByTestId('ops-incident-summary').innerText().catch(() => '')) ||
      (await this.page.locator('h1, h2').first().innerText().catch(() => '')) ||
      ''
    const combined = `${dash}\n${listSnippet}\n${monSnippet}`
    const err = dashSignal.visible || /error|fail|critical|problem|unhealthy/i.test(combined)
    const affected = dashSignal.problemCount > 0 || /stream|route|destination|connector|source/i.test(combined)
    const root = /401|403|timeout|connection|unreachable|credential|refused|5\d\d|source fetch|fetch failed|degraded/i.test(combined)
    const recovery = /retry|restart|edit|fix|resume|reconnect/i.test(combined)
    return {
      ERROR_VISIBLE: err ? 'YES' : 'NO',
      AFFECTED_RESOURCE_IDENTIFIABLE: affected ? 'YES' : 'NO',
      ROOT_CAUSE_VISIBLE: root ? 'YES' : 'NO',
      RECOVERY_ACTION_VISIBLE: recovery ? 'YES' : 'NO',
      pagesVisited,
    }
  }

  async clickStart(): Promise<void> {
    this.session.artifacts.action('stream-start', 'stream-detail', 'Start')
    const btn = this.page.getByRole('button', { name: /^(Start|Run|Enable)$/i }).first()
    const sw = this.page.getByRole('switch').first()
    if (await btn.count()) await btn.click()
    else if (await sw.count()) await sw.click()
    await this.page.waitForTimeout(800)
  }

  async clickStop(): Promise<void> {
    this.session.artifacts.action('stream-stop', 'stream-detail', 'Stop')
    // Canonical control is role=switch ("Stream scheduler: Running|Stopped"), not a Stop button.
    const sw = this.page.getByTestId('stream-run-control-switch').or(this.page.getByRole('switch').first())
    if (await sw.count()) {
      const checked = await sw.getAttribute('aria-checked')
      if (checked === 'true') await sw.click()
    } else {
      const btn = this.page.getByRole('button', { name: /^Stop$/i }).first()
      if (await btn.count()) await btn.click()
    }
    await this.page.waitForTimeout(1000)
  }

  async clickStartTwice(): Promise<void> {
    const btn = this.page.getByRole('button', { name: /^(Start|Run)$/i }).first()
    if (await btn.count()) {
      await btn.click()
      await btn.click({ timeout: SHORT }).catch(() => null)
    }
    await this.page.waitForTimeout(800)
  }

  async clickStopTwice(): Promise<void> {
    const btn = this.page.getByRole('button', { name: /^Stop$/i }).first()
    if (await btn.count()) {
      await btn.click()
      await btn.click({ timeout: SHORT }).catch(() => null)
    }
    await this.page.waitForTimeout(800)
  }

  async openEditByStreamId(streamId: number): Promise<void> {
    await this.session.goto(`/streams/${streamId}/edit`, 'stream-edit')
    await this.page.waitForTimeout(800)
  }

  async tryDelete(streamName?: string): Promise<{ message: string }> {
    this.session.artifacts.action('stream-delete', 'stream-edit', 'Delete')
    const btn = this.page.getByRole('button', { name: /^Delete$/i }).first()
    // Wait for Stop to release the delete guard (button becomes enabled).
    for (let i = 0; i < 30; i++) {
      if (!(await btn.count())) break
      if (!(await btn.isDisabled().catch(() => true))) break
      await this.page.waitForTimeout(500)
    }
    if (await btn.count()) {
      if (await btn.isDisabled().catch(() => false)) {
        const title = (await btn.getAttribute('title').catch(() => '')) || ''
        return { message: `Delete still disabled: ${title}` }
      }
      await btn.click({ timeout: ACTION })
    }
    await this.page.waitForTimeout(400)
    if (streamName) {
      const nameField = this.page.locator('input[data-testid$="-type-name"]').first()
      const dialogInput = this.page.getByRole('dialog').locator('input[type="text"]').first()
      if (await nameField.count()) await nameField.fill(streamName)
      else if (await dialogInput.count()) await dialogInput.fill(streamName)
    }
    const confirm = this.page.getByRole('button', { name: /Delete stream|Confirm|Yes/i }).last()
    if (await confirm.isVisible().catch(() => false)) {
      if (!(await confirm.isDisabled().catch(() => false))) await confirm.click().catch(() => null)
    }
    await this.page.waitForTimeout(1200)
    const msg =
      (await this.page.getByRole('alert').first().innerText().catch(() => '')) ||
      (await this.page.locator('body').innerText()).slice(0, 1500)
    return { message: msg }
  }

  async deleteBlockedGuidance(): Promise<string> {
    const title = this.page.getByRole('button', { name: /Delete/i }).first()
    const titleAttr = (await title.getAttribute('title').catch(() => '')) || ''
    const body = await this.visibleStatusText()
    return `${titleAttr}\n${body}`.slice(0, 2000)
  }

  async visibleStatusText(): Promise<string> {
    const body = await this.page.locator('body').innerText()
    return body.slice(0, 4000)
  }
}

export class StreamWizardPage {
  constructor(readonly session: OperatorSession) {}

  get page(): Page {
    return this.session.page
  }

  async open(): Promise<void> {
    await this.session.goto('/streams/new', 'stream-wizard')
    await this.page.locator('[data-testid="wizard-stepper"], #wizard-stepper').waitFor({ timeout: SHORT }).catch(() => null)
  }

  async next(): Promise<void> {
    this.session.artifacts.action('wizard-next', '/streams/new', 'Next')
    await this.page.getByRole('button', { name: /^Next$/i }).click()
    await this.page.waitForTimeout(500)
  }

  async back(): Promise<void> {
    this.session.artifacts.action('wizard-back', '/streams/new', 'Back')
    await this.page.getByRole('button', { name: /^Back$/i }).click()
    await this.page.waitForTimeout(400)
  }

  async deployCreateAndStart(): Promise<void> {
    this.session.artifacts.action('wizard-deploy', '/streams/new', 'Create and Start')
    const btn = this.page.getByTestId('deploy-create-and-start')
    if (await btn.count()) await btn.click()
    else await this.page.getByRole('button', { name: /Create and Start|Deploy|Start/i }).click()
    await this.page.waitForTimeout(1500)
  }
}
