import type { Page } from '@playwright/test'
import { TIMEOUTS } from '../helpers/types.js'
import type { OperatorSession } from './session.js'

const SHORT = TIMEOUTS.shortMs
const ACTION = TIMEOUTS.actionMs

export class ConnectorsPage {
  constructor(readonly session: OperatorSession) {}

  get page(): Page {
    return this.session.page
  }

  async openList(): Promise<void> {
    await this.session.goto('/connectors', 'connectors-list')
    await this.page.getByTestId('connectors-overview-page').waitFor({ timeout: SHORT }).catch(() => null)
  }

  async openCreate(): Promise<void> {
    await this.session.goto('/connectors/new', 'connector-create')
    await this.page.getByText(/Create Connector|Source type/i).first().waitFor({ timeout: SHORT })
  }

  async selectSourceType(label: RegExp): Promise<void> {
    const radio = this.page.getByRole('radio', { name: label })
    if (await radio.count()) {
      await radio.check({ timeout: SHORT })
      return
    }
    await this.page.locator('label').filter({ hasText: label }).first().click({ timeout: SHORT })
  }

  async fillHttpConnector(opts: {
    name: string
    baseUrl: string
    authType?: string
    bearerToken?: string
    basicUser?: string
    basicPass?: string
    apiKeyName?: string
    apiKeyValue?: string
  }): Promise<void> {
    this.session.artifacts.action('fill-http-connector', '/connectors/new', opts.name)
    await this.selectSourceType(/HTTP API Polling/i)
    await this.page.getByLabel(/Connector Name/).fill(opts.name)
    const base = this.page.getByLabel(/Host \/ Base URL/i)
    if (await base.count()) await base.fill(opts.baseUrl)
    else await this.page.getByPlaceholder(/https?:\/\//i).first().fill(opts.baseUrl)

    if (opts.authType) {
      const auth = this.page.getByLabel(/Authentication Type/i)
      if (await auth.count()) await auth.selectOption(opts.authType)
    }
    if (opts.bearerToken) {
      const tok = this.page.getByLabel(/Bearer Token/i)
      if (await tok.count()) await tok.fill(opts.bearerToken)
    }
    if (opts.basicUser) {
      await this.page.getByLabel(/Basic Username/i).fill(opts.basicUser)
      await this.page.getByLabel(/Basic Password/i).fill(opts.basicPass || '')
    }
    if (opts.apiKeyValue) {
      const name = this.page.getByLabel(/API Key Name/i)
      if (await name.count()) await name.fill(opts.apiKeyName || 'X-API-Key')
      await this.page.getByLabel(/API Key Value/i).fill(opts.apiKeyValue)
    }
  }

  async fillDatabaseConnector(opts: {
    name: string
    host: string
    port: number
    database: string
    username: string
    password: string
  }): Promise<void> {
    this.session.artifacts.action('fill-db-connector', '/connectors/new', opts.name)
    await this.selectSourceType(/Database query/i)
    await this.page.getByLabel(/Connector Name/).fill(opts.name)
    const host = this.page.getByLabel(/Database host/i).first()
    await host.waitFor({ timeout: SHORT })
    await host.fill(opts.host)
    const port = this.page.getByLabel(/Database port/i)
    if (await port.count()) await port.fill(String(opts.port))
    await this.page.getByLabel(/Database name/i).fill(opts.database)
    await this.page.getByLabel(/Database username/i).fill(opts.username)
    const pwd = this.page.locator('label').filter({ hasText: /^Password/ }).locator('input[type="password"]').first()
    if (await pwd.count()) await pwd.fill(opts.password)
    else await this.page.getByLabel(/Password/i).last().fill(opts.password)
    const ssl = this.page.locator('label').filter({ hasText: /SSL mode/i }).locator('select')
    if (await ssl.count()) await ssl.selectOption('DISABLE').catch(() => null)
  }

  async fillS3Connector(opts: {
    name: string
    endpoint: string
    bucket: string
    accessKey: string
    secretKey: string
    prefix?: string
  }): Promise<void> {
    this.session.artifacts.action('fill-s3-connector', '/connectors/new', opts.name)
    await this.selectSourceType(/S3 Object Polling/i)
    await this.page.getByLabel(/Connector Name/).fill(opts.name)
    const ep = this.page.getByLabel(/S3 Endpoint URL/i)
    if (await ep.count()) await ep.fill(opts.endpoint)
    else await this.page.getByLabel(/Endpoint/i).fill(opts.endpoint)
    await this.page.getByLabel(/S3 Bucket|Bucket/i).first().fill(opts.bucket)
    if (opts.prefix) {
      const p = this.page.getByLabel(/S3 Prefix|Prefix/i)
      if (await p.count()) await p.fill(opts.prefix)
    }
    await this.page.getByLabel(/S3 Access key|Access key/i).fill(opts.accessKey)
    await this.page.getByLabel(/S3 Secret key|Secret key/i).fill(opts.secretKey)
    const pathStyle = this.page.getByLabel(/Path.?style/i)
    if (await pathStyle.count()) await pathStyle.check().catch(() => null)
  }

  async fillSftpConnector(opts: {
    name: string
    host: string
    port: number
    username: string
    password: string
  }): Promise<void> {
    this.session.artifacts.action('fill-sftp-connector', '/connectors/new', opts.name)
    await this.selectSourceType(/Remote file polling/i)
    await this.page.getByLabel(/Connector Name/).fill(opts.name)
    await this.page.locator('#remote-file-host').fill(opts.host)
    const port = this.page.locator('#remote-file-port')
    if (await port.count()) await port.fill(String(opts.port))
    await this.page.locator('#remote-file-username').fill(opts.username)
    await this.page.locator('#remote-file-password').fill(opts.password)
    const policy = this.page.locator('#remote-known-hosts-policy')
    if (await policy.count()) await policy.selectOption('insecure_skip_verify').catch(() => null)
  }

  async fillWebhookConnector(opts: { name: string; payloadPreview?: string }): Promise<void> {
    this.session.artifacts.action('fill-webhook-connector', '/connectors/new', opts.name)
    await this.selectSourceType(/Webhook Receiver/i)
    await this.page.getByLabel(/Connector Name/).fill(opts.name)
    if (opts.payloadPreview) {
      const preview = this.page.getByLabel(/Payload preview/i)
      if (await preview.count()) await preview.fill(opts.payloadPreview)
    }
  }

  async save(): Promise<void> {
    this.session.artifacts.action('save-connector', '/connectors/new', 'click Save Connector')
    await this.page.getByRole('button', { name: /Save Connector/i }).click()
    await this.page.waitForURL(/\/connectors\/\d+/, { timeout: ACTION }).catch(() => null)
    await this.page.waitForTimeout(500)
  }

  async saveTwice(): Promise<void> {
    const btn = this.page.getByRole('button', { name: /Save Connector/i })
    await btn.click()
    await btn.click({ timeout: SHORT }).catch(() => null)
    await this.page.waitForTimeout(1000)
  }

  async setAuthTestPath(pathName: string): Promise<void> {
    const field = this.page.getByLabel(/Test path/i)
    if (await field.count()) await field.fill(pathName)
  }

  async openDetail(id: number): Promise<void> {
    this.session.artifacts.action('open-connector-detail', `/connectors/${id}`, `id=${id}`)
    await this.session.goto(`/connectors/${id}`, 'connector-detail')
    await this.page.getByLabel(/Connector Name/i).first().waitFor({ timeout: ACTION }).catch(() => null)
  }

  async testAuth(): Promise<{ visibleText: string }> {
    this.session.artifacts.action('test-auth', 'connector-detail', 'Test Auth')
    const btn = this.page
      .getByRole('button', {
        name: /Test Authentication|Test database connectivity|Test remote file connectivity|S3 connectivity|Check Auth/i,
      })
      .first()
    if (await btn.count()) {
      await btn.click()
    } else {
      const alt = this.page.getByRole('button', { name: /^Test Auth$/i }).first()
      if (await alt.count()) await alt.click()
    }
    const banner = this.page.getByTestId('auth-test-result-banner')
    const pre = this.page.getByTestId('auth-test-result-detail')
    const rowToast = this.page.getByTestId('connector-row-auth-result')
    await banner.waitFor({ timeout: ACTION }).catch(() => null)
    if (!(await banner.count())) {
      await rowToast.waitFor({ timeout: SHORT }).catch(() => null)
    }
    const text = [
      (await banner.textContent({ timeout: 1000 }).catch(() => null)) || '',
      (await pre.textContent({ timeout: 1000 }).catch(() => null)) || '',
      (await rowToast.textContent({ timeout: 500 }).catch(() => null)) || '',
    ]
      .filter(Boolean)
      .join('\n')
    return { visibleText: text.slice(0, 2000) }
  }

  async tryDelete(): Promise<{ message: string }> {
    this.session.artifacts.action('connector-delete', 'connector-detail', 'Delete')
    const btn = this.page.getByRole('button', { name: /Delete/i }).first()
    if (await btn.count()) await btn.click()
    const confirm = this.page.getByRole('button', { name: /Confirm|Delete|Yes/i }).last()
    if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => null)
    await this.page.waitForTimeout(800)
    const msg =
      (await this.page.getByRole('alert').first().innerText().catch(() => '')) ||
      (await this.page.locator('body').innerText()).slice(0, 1500)
    return { message: msg }
  }

  async openDetailByName(name: string): Promise<boolean> {
    await this.openList()
    this.session.artifacts.action('open-connector-detail', '/connectors', name)
    const short = name.length > 24 ? name.slice(-24) : name
    const row = this.page.locator(`[data-testid^="connector-row-"]`, { hasText: short }).first()
    await row.waitFor({ timeout: ACTION }).catch(() => null)
    if (await row.count()) {
      const edit = row.getByRole('link', { name: /^Edit$/i })
      if (await edit.count()) await edit.click({ timeout: SHORT })
      else await row.click({ timeout: SHORT })
      await this.page.waitForURL(/\/connectors\/\d+/, { timeout: ACTION }).catch(() => null)
      await this.page.getByLabel(/Connector Name/i).first().waitFor({ timeout: SHORT }).catch(() => null)
      return /\/connectors\/\d+/.test(this.page.url())
    }
    const text = this.page.getByText(short, { exact: false }).first()
    if (await text.count()) {
      await text.click({ timeout: SHORT }).catch(() => null)
      await this.page.waitForTimeout(500)
      return /\/connectors\/\d+/.test(this.page.url())
    }
    return false
  }

  async visibleErrorText(): Promise<string> {
    const alert = this.page.getByRole('alert').first()
    if (await alert.count()) return (await alert.innerText()).slice(0, 1000)
    const err = this.page.locator('.text-red-600, .text-red-300, [data-testid*="error"]').first()
    if (await err.count()) return (await err.innerText()).slice(0, 1000)
    return ''
  }
}
