import type { Page, Request, Response } from '@playwright/test'
import { uiLogin } from '../../framework/browser/ui-helpers.js'
import type { ArtifactStore } from '../helpers/artifacts.js'
import { TIMEOUTS } from '../helpers/types.js'
import { redactText } from '../helpers/redact.js'

export class OperatorSession {
  consoleErrors: string[] = []
  private networkHookInstalled = false

  constructor(
    readonly page: Page,
    readonly uiBase: string,
    readonly artifacts: ArtifactStore,
  ) {}

  async login(): Promise<void> {
    this.artifacts.action('login', '/', 'uiLogin')
    await uiLogin(this.page, this.uiBase)
  }

  installNetworkCapture(actionLabel = 'nav'): void {
    if (this.networkHookInstalled) return
    this.networkHookInstalled = true
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') this.consoleErrors.push(redactText(msg.text()).slice(0, 500))
    })
    this.page.on('pageerror', (err) => {
      this.consoleErrors.push(redactText(String(err)).slice(0, 500))
    })
    this.page.on('response', (res: Response) => {
      const req: Request = res.request()
      const url = req.url()
      if (!url.includes('/api/')) return
      let pathName = url
      try {
        pathName = new URL(url).pathname
      } catch {
        /* keep */
      }
      this.artifacts.network(actionLabel, req.method(), pathName, res.status())
    })
  }

  async goto(path: string, label: string): Promise<void> {
    this.artifacts.action('navigate', path, label)
    await this.page.goto(`${this.uiBase}${path}`, {
      timeout: TIMEOUTS.navMs,
      waitUntil: 'domcontentloaded',
    })
  }

  async screenshotOnFail(name: string): Promise<string> {
    const file = `${this.artifacts.screenshots}/${name}.png`
    await this.page.screenshot({ path: file, fullPage: true }).catch(() => null)
    return file
  }
}
