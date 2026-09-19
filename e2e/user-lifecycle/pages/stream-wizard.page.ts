import type { Page } from '@playwright/test'
import { TIMEOUTS } from '../helpers/types.js'
import type { OperatorSession } from './session.js'

const SHORT = TIMEOUTS.shortMs
const ACTION = TIMEOUTS.actionMs

/**
 * Browser Stream Wizard operator (Connect → Sample → Destinations → Route Processing → Deploy).
 */
export class StreamWizardOperator {
  constructor(readonly session: OperatorSession) {}

  get page(): Page {
    return this.session.page
  }

  async openFresh(): Promise<void> {
    await this.session.goto('/streams/new', 'stream-wizard')
    const banner = this.page.getByTestId('wizard-draft-start-fresh')
    if (await banner.isVisible().catch(() => false)) {
      await banner.click()
      await this.page.waitForTimeout(400)
    }
    await this.page.getByTestId('wizard-step-connect').waitFor({ timeout: ACTION }).catch(() => null)
  }

  async fillLabeledInput(label: string, value: string): Promise<boolean> {
    const field = this.page.locator('div.space-y-1, label').filter({ hasText: label }).locator('input, textarea, select').first()
    if (!(await field.count())) return false
    await field.fill(value)
    return true
  }

  async selectSavedConnector(connectorName: string): Promise<void> {
    this.session.artifacts.action('wizard-select-connector', '/streams/new', connectorName)
    const sel = this.page.getByTestId('wizard-saved-connector-select')
    await sel.waitFor({ timeout: ACTION })
    const options = await sel.locator('option').allTextContents()
    const match = options.find((o) => o.includes(connectorName))
    if (!match) throw new Error(`connector option not found: ${connectorName}; have=${options.slice(0, 8).join('|')}`)
    await sel.selectOption({ label: match })
    await this.page.getByText(/Inherited from connector/i).waitFor({ timeout: ACTION }).catch(() => null)
    await this.page.waitForTimeout(400)
  }

  async configureHttpEndpoint(endpointPath: string, streamName?: string, pollingSec?: number): Promise<void> {
    this.session.artifacts.action('wizard-endpoint', '/streams/new', endpointPath)
    const requestTab = this.page.getByTestId('wizard-connect-tab-request')
    if (await requestTab.count()) await requestTab.click()
    else {
      const openReq = this.page.getByTestId('wizard-connect-open-request-configuration')
      if (await openReq.count()) await openReq.click()
    }
    await this.page.getByTestId('wizard-connect-request').waitFor({ timeout: SHORT }).catch(() => null)
    if (streamName) {
      const named = await this.fillLabeledInput('Stream name', streamName)
      if (!named) {
        const name = this.page.getByLabel(/Stream Name|Name/i).first()
        if (await name.count()) await name.fill(streamName)
      }
    }
    const filled = await this.fillLabeledInput('Endpoint path', endpointPath)
    if (!filled) {
      const endpoint = this.page.getByLabel(/Endpoint path/i)
      if (await endpoint.count()) await endpoint.fill(endpointPath)
    }
    if (pollingSec) {
      const adv = this.page.getByTestId('wizard-connect-tab-advanced')
      if (await adv.count()) {
        await adv.click()
        await this.fillLabeledInput('Polling interval', String(pollingSec))
        await requestTab.click().catch(() => null)
      }
    }
  }

  async configureS3Stream(streamName: string, pollingSec?: number): Promise<void> {
    this.session.artifacts.action('wizard-s3-config', '/streams/new', streamName)
    const requestTab = this.page.getByTestId('wizard-connect-tab-request')
    if (await requestTab.count()) await requestTab.click()
    await this.fillLabeledInput('Stream name', streamName)
    if (pollingSec) {
      const adv = this.page.getByTestId('wizard-connect-tab-advanced')
      if (await adv.count()) {
        await adv.click()
        await this.fillLabeledInput('Polling interval', String(pollingSec))
      }
    }
  }

  async configureSftpStream(opts: {
    streamName: string
    remoteDirectory: string
    filePattern: string
    pollingSec?: number
  }): Promise<void> {
    this.session.artifacts.action('wizard-sftp-config', '/streams/new', opts.streamName)
    const requestTab = this.page.getByTestId('wizard-connect-tab-request')
    if (await requestTab.count()) await requestTab.click()
    await this.fillLabeledInput('Stream name', opts.streamName)
    await this.fillLabeledInput('Remote directory', opts.remoteDirectory)
    await this.fillLabeledInput('File pattern', opts.filePattern)
    if (opts.pollingSec) {
      const adv = this.page.getByTestId('wizard-connect-tab-advanced')
      if (await adv.count()) {
        await adv.click()
        await this.fillLabeledInput('Polling interval', String(opts.pollingSec))
      }
    }
  }

  async configureWebhookStream(streamName: string): Promise<void> {
    this.session.artifacts.action('wizard-webhook-config', '/streams/new', streamName)
    const requestTab = this.page.getByTestId('wizard-connect-tab-request')
    if (await requestTab.count()) await requestTab.click()
    await this.fillLabeledInput('Stream name', streamName)
  }

  async clickNext(expectedLabel?: RegExp): Promise<void> {
    this.session.artifacts.action('wizard-next', '/streams/new', expectedLabel?.source || 'Next')
    const named = expectedLabel
      ? this.page.getByRole('button', { name: expectedLabel }).last()
      : this.page.getByRole('button', { name: /^Next/i }).last()
    await named.waitFor({ state: 'visible', timeout: ACTION })
    for (let i = 0; i < 12; i++) {
      if (!(await named.isDisabled().catch(() => false))) break
      await this.page.waitForTimeout(400)
    }
    await named.click({ timeout: ACTION })
    await this.page.waitForTimeout(700)
  }

  async clickBack(): Promise<void> {
    this.session.artifacts.action('wizard-back', '/streams/new', 'Back')
    await this.page.getByRole('button', { name: /^Back$/i }).click({ timeout: ACTION })
    await this.page.waitForTimeout(400)
  }

  async readEndpointValue(): Promise<string> {
    const input = this.page.locator('div.space-y-1').filter({ hasText: 'Endpoint path' }).locator('input').first()
    if (await input.count()) return (await input.inputValue()) || ''
    return ''
  }

  async runSampleTest(opts?: { allowConnectivitySample?: boolean }): Promise<boolean> {
    this.session.artifacts.action('wizard-run-test', '/streams/new', 'Run Test')
    await this.page.getByTestId('wizard-step-sample').waitFor({ timeout: ACTION }).catch(() => null)
    const runBtn = this.page.getByRole('button', { name: /Run Test/i }).first()
    await runBtn.click({ timeout: ACTION })
    const ok = await this.page
      .getByTestId('wizard-run-test-success')
      .waitFor({ timeout: ACTION })
      .then(() => true)
      .catch(() => false)
    if (!ok) return false
    const treeText = (await this.page.getByTestId('wizard-record-selection-json-tree').innerText().catch(() => '')) || ''
    const bodyText = await this.page.locator('body').innerText()
    const probeOnly =
      /ssh_reachable|sftp_available|sample_remote_paths/i.test(treeText) &&
      !/\brun_id\b|\bevent_id\b|\bmessage\b|\bid\b/i.test(treeText.replace(/ssh_reachable|sftp_available|sample_remote_paths|db_select_ok/gi, ''))
    if (probeOnly && !opts?.allowConnectivitySample && !/extracted events|records detected/i.test(bodyText)) {
      this.session.artifacts.action('wizard-run-test-probe-only', '/streams/new', 'probe sample without events')
      return false
    }
    const openSel = this.page.getByTestId('wizard-run-test-open-record-selection')
    if (await openSel.count()) await openSel.click()
    else await this.page.getByTestId('wizard-sample-tab-record_selection').click().catch(() => null)
    return true
  }

  async confirmRecordSelectionBestEffort(eventArrayPath = '$.items', checkpointPath = 'id'): Promise<void> {
    this.session.artifacts.action('wizard-record-selection', '/streams/new', `${eventArrayPath} ${checkpointPath}`)
    await this.page.getByTestId('wizard-sample-tab-record_selection').click().catch(() => null)
    await this.page.waitForTimeout(400)
    const cp = checkpointPath.startsWith('$') ? checkpointPath : `$.${checkpointPath}`
    const leaf = checkpointPath.replace(/^\$\.?/, '').split('.').pop() || checkpointPath

    // Prefer whole-root for NDJSON / DB / single-object samples when path is `$`.
    if (eventArrayPath === '$' || eventArrayPath === '') {
      const useRoot = this.page.getByRole('button', { name: /Use root object|Use entire response|Whole response/i }).first()
      if (await useRoot.isVisible().catch(() => false)) await useRoot.click().catch(() => null)
    }

    const advanced = this.page.getByRole('button', { name: 'Advanced (Custom)' })
    if (await advanced.count()) await advanced.click().catch(() => null)
    await this.page.waitForTimeout(300)
    const arrayInput = this.page.locator('label').filter({ hasText: /Event array path/i }).locator('input')
    if (await arrayInput.count()) await arrayInput.fill(eventArrayPath)
    const cpInput = this.page.locator('label').filter({ hasText: /Sync position path/i }).locator('input')
    if (await cpInput.count()) await cpInput.fill(cp)
    const validate = this.page.getByRole('button', { name: /Validate & Preview/i }).first()
    if (await validate.isVisible().catch(() => false)) {
      await validate.click().catch(() => null)
      await this.page.waitForTimeout(800)
    }
    const nextAfterAdvanced = this.page.getByRole('button', { name: /Next: Destinations/i }).last()
    if (
      !(await this.page.getByText(/Next is blocked/i).isVisible().catch(() => false)) &&
      (await nextAfterAdvanced.isEnabled().catch(() => false))
    ) {
      return
    }

    const basic = this.page.getByRole('button', { name: 'Basic (Tree)' })
    if (await basic.count()) await basic.click().catch(() => null)
    await this.page.waitForTimeout(200)
    const eventSource = this.page.getByRole('button', { name: /^Event source$/i })
    if (await eventSource.count()) await eventSource.last().click().catch(() => null)
    const eventRoot = this.page.getByRole('button', { name: /^Event root$/i })
    if (await eventRoot.count()) await eventRoot.first().click().catch(() => null)
    const expanders = this.page.locator('[data-testid="wizard-record-selection-json-tree"] [aria-expanded="false"]')
    const expCount = await expanders.count()
    for (let i = 0; i < Math.min(expCount, 6); i++) {
      await expanders.nth(i).click().catch(() => null)
    }
    const tree = this.page.getByTestId('wizard-record-selection-json-tree')
    const leafNode = tree.getByText(new RegExp(`^${leaf}$`)).first()
    if (await leafNode.count()) await leafNode.click().catch(() => null)
    else {
      const idNode = tree.getByText(/^id$/).first()
      if (await idNode.count()) await idNode.click().catch(() => null)
    }
    const syncBtns = this.page.getByRole('button', { name: /^Sync position$/i })
    const n = await syncBtns.count()
    if (n > 0) await syncBtns.last().click().catch(() => null)

    for (let i = 0; i < 10; i++) {
      const blocked = await this.page.getByText(/Next is blocked/i).isVisible().catch(() => false)
      const next = this.page.getByRole('button', { name: /Next: Destinations/i }).last()
      const enabled = await next.isEnabled().catch(() => false)
      if (!blocked && enabled) return
      if (await eventSource.count()) await eventSource.last().click().catch(() => null)
      if (await leafNode.count()) await leafNode.click().catch(() => null)
      if (n > 0) await syncBtns.last().click().catch(() => null)
      const useRoot = this.page.getByRole('button', { name: /Use root object|Use entire response|Whole response/i }).first()
      if (await useRoot.isVisible().catch(() => false)) await useRoot.click().catch(() => null)
      if (await validate.isVisible().catch(() => false)) await validate.click().catch(() => null)
      await this.page.waitForTimeout(500)
    }
  }

  async addDestinationRoutes(destinationNames: string[]): Promise<void> {
    this.session.artifacts.action('wizard-destinations', '/streams/new', destinationNames.join(','))
    await this.page.getByText(/Destination library|Destinations/i).first().waitFor({ timeout: ACTION }).catch(() => null)
    const search = this.page.getByPlaceholder(/Search destinations/i)
    for (const name of destinationNames) {
      if (await search.count()) {
        await search.fill(name)
        await this.page.waitForTimeout(300)
      }
      const row = this.page.locator('#wizard-destination-library li, aside li').filter({ hasText: name }).first()
      const add = row.getByRole('button', { name: /Add delivery path|Add|Use|Select/i }).first()
      if (await add.count()) await add.click()
      else await this.page.getByRole('button', { name: /Add delivery path/i }).first().click().catch(() => null)
      await this.page.waitForTimeout(400)
    }
  }

  async configureProtectionPartialAndFull(): Promise<void> {
    this.session.artifacts.action('wizard-protection', '/streams/new', 'partial+full')
    const sharedProt = this.page.getByTestId('shared-processing-tab-data_protection')
    if (await sharedProt.count()) await sharedProt.click()
    const configure = this.page.getByTestId('wizard-data-protection-configure')
    const edit = this.page.getByTestId('wizard-data-protection-edit')
    if (await configure.count()) await configure.click().catch(() => null)
    else if (await edit.count()) await edit.click().catch(() => null)
    const add = this.page.getByTestId('data-protection-add-row')
    if (await add.count()) await add.click()
    const field = this.page.locator('input[placeholder="$.email"]').last()
    if (await field.count()) await field.fill('$.email')
    const action = this.page.locator('select').filter({ hasText: /Mask/ }).first()
    if (await action.count()) await action.selectOption('mask_partial').catch(() => null)
    else {
      const anySelect = this.page.locator('[data-testid^="data-protection-row-"] select').first()
      if (await anySelect.count()) await anySelect.selectOption('mask_partial').catch(() => null)
    }
    const addOverride = this.page.getByRole('button', { name: /Add Override/i }).first()
    if (await addOverride.count()) {
      await addOverride.click().catch(() => null)
      const overrideAction = this.page.locator('[data-testid^="route-override-row-"] select').nth(1)
      if (await overrideAction.count()) await overrideAction.selectOption('mask_full').catch(() => null)
    }
    const close = this.page.getByTestId('wizard-data-protection-drawer-close')
    if (await close.count()) await close.click().catch(() => null)
  }

  async configureRouteBTransformRename(): Promise<void> {
    this.session.artifacts.action('wizard-transform-route-b', '/streams/new', 'message→transformed_message')
    const cards = this.page.locator('[data-testid^="route-processing-list-card-"]')
    if ((await cards.count()) >= 2) await cards.nth(1).click()
    const override = this.page.getByTestId('route-processing-mode-override')
    if (await override.count()) await override.click()
    else await this.page.getByRole('button', { name: /Override for this Route/i }).click().catch(() => null)
    const xfTab = this.page.getByTestId('route-detail-tab-transform')
    if (await xfTab.count()) await xfTab.click()
    const panel = this.page.getByTestId('route-detail-transform')
    await panel.waitFor({ timeout: ACTION }).catch(() => null)
    const msgChip = panel.locator('button[title="message"]').last()
    if (await msgChip.count()) {
      await msgChip.click()
    } else {
      const addRow = panel.getByRole('button', { name: /^Add row$/i }).first()
      if (await addRow.count()) await addRow.click()
      const src = panel.getByLabel(/Source JSONPath/i).last()
      if (await src.count()) await src.fill('$.message')
      const destChip = panel.getByRole('button', { name: /Choose destination|Destination field/i }).last()
      if (await destChip.count()) await destChip.click().catch(() => null)
    }
    await this.page.waitForTimeout(200)
    const search = this.page.getByLabel(/Search or type destination field name/i)
    if (await search.count()) {
      await search.fill('transformed_message')
      const create = this.page.getByRole('button', { name: /Create custom field/i })
      if (await create.isVisible().catch(() => false)) await create.click().catch(() => null)
      else await search.press('Enter').catch(() => null)
    }
    const drop = panel.getByTestId('unmapped-fields-policy-pass_through')
    if (await drop.count()) await drop.click().catch(() => null)
  }

  async configureSharedIdentityMapping(): Promise<void> {
    this.session.artifacts.action('wizard-shared-mapping', '/streams/new', 'auto-suggest+id')
    const xf = this.page.getByTestId('shared-processing-tab-transform')
    if (await xf.count()) await xf.click()
    const suggest = this.page.getByRole('button', { name: /Auto-suggest top-level fields/i }).first()
    if (await suggest.count()) await suggest.click().catch(() => null)
    await this.page.waitForTimeout(400)
    if ((await this.page.getByLabel('Source JSONPath').count()) === 0) {
      const add = this.page.getByRole('button', { name: /^Add row$/i }).first()
      if (await add.count()) await add.click()
      const src = this.page.getByLabel('Source JSONPath').last()
      if (await src.count()) await src.fill('$.id')
      const destChip = this.page.getByRole('button', { name: /Choose destination|Destination field/i }).last()
      if (await destChip.count()) {
        await destChip.click()
        const search = this.page.getByLabel(/Search or type destination field name/i)
        if (await search.count()) {
          await search.fill('id')
          await search.press('Enter')
        }
      }
    }
    const pass = this.page.getByTestId('unmapped-fields-policy-pass_through')
    if (await pass.count()) await pass.click().catch(() => null)
  }

  async recoverConnectAfterReload(connectorName: string, endpointPath: string, streamName?: string, pollingSec?: number): Promise<void> {
    const stepper = this.page.getByTestId('wizard-stepper')
    if (await stepper.count()) {
      await stepper.locator('button').first().click().catch(() => null)
      await this.page.waitForTimeout(400)
    } else {
      const back = this.page.getByRole('button', { name: /^Back$/i })
      for (let i = 0; i < 3; i++) {
        if (await this.page.getByTestId('wizard-saved-connector-select').count()) break
        if (await back.isEnabled().catch(() => false)) await back.click().catch(() => null)
        await this.page.waitForTimeout(300)
      }
    }
    if (await this.page.getByTestId('wizard-saved-connector-select').count()) {
      await this.selectSavedConnector(connectorName)
    }
    await this.configureHttpEndpoint(endpointPath, streamName, pollingSec)
  }

  async deploy(): Promise<void> {
    this.session.artifacts.action('wizard-deploy', '/streams/new', 'Create and Start')
    const btn = this.page.getByTestId('deploy-create-and-start')
    for (let i = 0; i < 8; i++) {
      if (await btn.count()) {
        if (!(await btn.isDisabled().catch(() => true))) break
        await this.configureSharedIdentityMapping()
        await this.page.waitForTimeout(400)
      } else break
    }
    if (await btn.count()) await btn.click({ timeout: ACTION })
    else await this.page.getByRole('button', { name: /Create and Start|Deploy/i }).click({ timeout: ACTION })
    await this.page.waitForTimeout(2500)
  }

  async requiredFieldBlocksNext(): Promise<boolean> {
    const next = this.page.getByRole('button', { name: /^Next/i }).last()
    return (await next.isDisabled().catch(() => false)) === true
  }

  /**
   * Representative HTTP stream journey. Returns whether deploy appeared to succeed.
   */
  async createHttpStreamJourney(opts: {
    connectorName: string
    streamName: string
    endpointPath: string
    destinationNames: string[]
    eventArrayPath?: string
    pollingSec?: number
    withBackReload?: boolean
    withProtection?: boolean
    withTransform?: boolean
  }): Promise<{ ok: boolean; note: string }> {
    try {
      await this.openFresh()
      await this.selectSavedConnector(opts.connectorName)
      await this.configureHttpEndpoint(opts.endpointPath, opts.streamName, opts.pollingSec ?? 15)
      if (opts.withBackReload) {
        await this.clickNext(/Sample/i)
        await this.clickBack()
        const preserved = (await this.readEndpointValue()).includes(opts.endpointPath.replace(/^\//, '')) ||
          (await this.readEndpointValue()) === opts.endpointPath
        await this.page.reload({ waitUntil: 'domcontentloaded' })
        await this.page.waitForTimeout(800)
        const afterReload = await this.page.locator('body').innerText()
        const nameKept = Boolean(opts.streamName) && afterReload.includes(opts.streamName as string)
        this.session.artifacts.action(
          'wizard-back-reload-check',
          '/streams/new',
          `preserved=${preserved} nameKept=${nameKept}`,
        )
        await this.recoverConnectAfterReload(
          opts.connectorName,
          opts.endpointPath,
          opts.streamName,
          opts.pollingSec ?? 15,
        )
      }
      await this.clickNext(/Sample/i)
      const sampleOk = await this.runSampleTest()
      if (!sampleOk) return { ok: false, note: 'sample test did not show success' }
      await this.confirmRecordSelectionBestEffort(opts.eventArrayPath || '$.items', 'id')
      await this.clickNext(/Destination/i)
      await this.addDestinationRoutes(opts.destinationNames)
      await this.clickNext(/Route Processing/i)
      await this.page.getByTestId('wizard-step-route-processing').waitFor({ timeout: SHORT }).catch(() => null)
      await this.configureSharedIdentityMapping()
      if (opts.withProtection) await this.configureProtectionPartialAndFull()
      if (opts.withTransform) await this.configureRouteBTransformRename()
      await this.clickNext(/Deploy/i)
      await this.deploy()
      return { ok: true, note: 'deploy clicked' }
    } catch (e) {
      await this.session.screenshotOnFail(`wizard-fail-${Date.now()}`)
      return { ok: false, note: String(e).slice(0, 400) }
    }
  }

  async configureDatabaseStream(opts: {
    streamName: string
    sqlQuery: string
    checkpointColumn?: string
    pollingSec?: number
  }): Promise<void> {
    this.session.artifacts.action('wizard-database-config', '/streams/new', opts.streamName)
    const requestTab = this.page.getByTestId('wizard-connect-tab-request')
    if (await requestTab.count()) await requestTab.click()
    await this.fillLabeledInput('Stream name', opts.streamName)
    const sql = this.page.getByTestId('wizard-database-sql-query')
    if (await sql.count()) await sql.fill(opts.sqlQuery)
    else await this.fillLabeledInput('SQL query', opts.sqlQuery)
    if (opts.checkpointColumn) {
      const ck = this.page.getByTestId('wizard-database-checkpoint-column')
      if (await ck.count()) await ck.fill(opts.checkpointColumn)
    }
    if (opts.pollingSec) {
      const adv = this.page.getByTestId('wizard-connect-tab-advanced')
      if (await adv.count()) {
        await adv.click()
        await this.fillLabeledInput('Polling interval', String(opts.pollingSec))
      }
    }
  }

  async createFamilyStreamJourney(opts: {
    family: 'S3' | 'SFTP' | 'WEBHOOK' | 'DATABASE'
    connectorName: string
    streamName: string
    destinationNames: string[]
    remoteDirectory?: string
    filePattern?: string
    sqlQuery?: string
    pollingSec?: number
  }): Promise<{ ok: boolean; note: string; notSupported?: boolean }> {
    try {
      await this.openFresh()
      await this.selectSavedConnector(opts.connectorName)
      await this.page.waitForTimeout(700)
      const body = await this.page.locator('body').innerText()
      if (opts.family === 'DATABASE') {
        const stillHttp = /Endpoint path/i.test(body) && !/SQL query/i.test(body)
        if (stillHttp) {
          return {
            ok: false,
            notSupported: true,
            note: 'NOT_SUPPORTED_BY_CURRENT_UI: Stream Wizard still maps DATABASE_QUERY to HTTP endpoint fields',
          }
        }
        await this.configureDatabaseStream({
          streamName: opts.streamName,
          sqlQuery:
            opts.sqlQuery ||
            (opts.streamName.includes('users')
              ? 'SELECT id, event_id, message, email FROM source_e2e_users'
              : 'SELECT id, event_id, message, email FROM source_e2e_orders'),
          checkpointColumn: 'id',
          pollingSec: opts.pollingSec ?? 15,
        })
      } else if (opts.family === 'S3') await this.configureS3Stream(opts.streamName, opts.pollingSec ?? 15)
      else if (opts.family === 'SFTP') {
        await this.configureSftpStream({
          streamName: opts.streamName,
          remoteDirectory: opts.remoteDirectory || '/upload',
          filePattern: opts.filePattern || '*.ndjson',
          pollingSec: opts.pollingSec ?? 15,
        })
      } else if (opts.family === 'WEBHOOK') await this.configureWebhookStream(opts.streamName)
      else await this.fillLabeledInput('Stream name', opts.streamName)
      await this.clickNext(/Sample/i)
      const sampleOk = await this.runSampleTest({
        allowConnectivitySample: opts.family === 'SFTP' || opts.family === 'WEBHOOK',
      })
      if (!sampleOk) return { ok: false, note: `${opts.family} sample test did not show success` }
      if (opts.family !== 'SFTP' && opts.family !== 'WEBHOOK') {
        const eventPath = opts.family === 'DATABASE' ? '$' : '$'
        const checkpoint = opts.family === 'DATABASE' ? 'id' : 'run_id'
        await this.confirmRecordSelectionBestEffort(eventPath, checkpoint)
      }
      await this.clickNext(/Destination/i)
      await this.addDestinationRoutes(opts.destinationNames)
      await this.clickNext(/Route Processing/i)
      await this.configureSharedIdentityMapping()
      await this.clickNext(/Deploy/i)
      await this.deploy()
      return { ok: true, note: `${opts.family} deploy clicked` }
    } catch (e) {
      await this.session.screenshotOnFail(`wizard-${opts.family}-fail-${Date.now()}`)
      return { ok: false, note: String(e).slice(0, 400) }
    }
  }
}
