import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { ArtifactStore } from './artifacts.js'

const CONTROL_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
].join(',')

function clean(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
}

function inferredRole(tag: string, explicit: string | null, type: string | null): string {
  if (explicit) return explicit
  if (tag === 'a') return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return type
  if (tag === 'input') return 'textbox'
  return tag
}
function updateCensusCounters(store: ArtifactStore, pagesPath: string, controlsPath: string): void {
  const pageRows = fs.existsSync(pagesPath)
    ? fs.readFileSync(pagesPath, 'utf8').split(/\r?\n/).slice(1).filter(Boolean)
    : []
  const controlRows = fs.existsSync(controlsPath)
    ? fs.readFileSync(controlsPath, 'utf8').split(/\r?\n/).slice(1).filter(Boolean)
    : []
  const states = new Set(
    pageRows
      .map((row) => row.split('\t')[1] || '')
      .filter(Boolean),
  )
  store.setFlag('CENSUS_PAGE_STATE_COUNT', String(pageRows.length))
  store.setFlag('CENSUS_STATE_COUNT', String(states.size))
  store.setFlag('CENSUS_VISIBLE_CONTROL_COUNT', String(controlRows.length))
  store.setFlag('CENSUS_STATES', Array.from(states).sort().join(','))
}

function ensureLedger(store: ArtifactStore) {
  const dir = path.join(store.dir, 'ledger')
  fs.mkdirSync(dir, { recursive: true })
  const pages = path.join(dir, 'page-ledger.tsv')
  const controls = path.join(dir, 'control-ledger.tsv')
  if (!fs.existsSync(pages)) {
    fs.writeFileSync(pages, 'PAGE\tSTATE\tURL\tVISIBLE_CONTROL_COUNT\n')
  }
  if (!fs.existsSync(controls)) {
    fs.writeFileSync(
      controls,
      'CONTROL_ID\tPAGE\tSTATE\tCONTROL_TYPE\tACCESSIBLE_NAME\tENABLED\tHREF\n',
    )
  }
  return { pages, controls }
}

export async function captureBrowserCensus(
  page: Page,
  store: ArtifactStore,
  pageKey: string,
  state: string,
): Promise<number> {
  const { pages, controls } = ensureLedger(store)
  const locator = page.locator(CONTROL_SELECTOR)
  const visibleControls = await locator.evaluateAll((elements) =>
    elements.flatMap((el) => {
      const html = el as HTMLElement
      const input = el as HTMLInputElement
      const style = window.getComputedStyle(html)
      const rect = html.getBoundingClientRect()
      const visible =
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      if (!visible) return []
      const id = el.getAttribute('id')
      const label =
        (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : '') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        html.innerText ||
        ''
      return [{
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        name: label,
        href: el.getAttribute('href') || '',
        disabled: Boolean(input.disabled) || el.getAttribute('aria-disabled') === 'true',
      }]
    }),
  )
  const rows: string[] = []
  for (const [index, meta] of visibleControls.entries()) {
    const role = inferredRole(meta.tag, meta.role, meta.type)
    const name = clean(String(meta.name || 'unnamed'))
    const controlId = clean(`${pageKey}|${state}|${role}|${name}|${index + 1}`)
    rows.push(
      [controlId, clean(pageKey), clean(state), clean(role), name, meta.disabled ? 'NO' : 'YES', clean(meta.href)].join('\t'),
    )
  }
  fs.appendFileSync(
    pages,
    [clean(pageKey), clean(state), clean(page.url()), String(rows.length)].join('\t') + '\n',
  )
  if (rows.length) fs.appendFileSync(controls, rows.join('\n') + '\n')
  updateCensusCounters(store, pages, controls)
  return rows.length
}

export async function runBaselinePublicCensus(page: Page, store: ArtifactStore, uiBase: string): Promise<void> {
  const paths = [
    '/monitoring',
    '/connectors',
    '/streams',
    '/destinations',
    '/routes',
    '/logs',
    '/alerts',
    '/governance',
    '/governance/operations',
    '/governance/violations',
    '/governance/quarantine',
    '/governance/audit',
    '/governance/replay',
    '/governance/approvals',
    '/governance/notifications',
    '/governance/workspace',
    '/admin',
    '/settings',
    '/operations/backup',
  ]
  let controls = 0
  for (const route of paths) {
    await page.goto(`${uiBase}${route}`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.waitForTimeout(350)
    controls += await captureBrowserCensus(page, store, route, 'EMPTY')
  }
  store.setFlag('PUBLIC_PAGE_COUNT_BASELINE', String(paths.length))
  store.setFlag('PUBLIC_ACTION_CONTROL_COUNT_BASELINE', String(controls))
  store.rec(
    'BFS_CONTROL_CENSUS_BASELINE',
    controls > 0 ? 'PASS' : 'FAIL',
    `pages=${paths.length} visibleControls=${controls}`,
    ['BROWSER_E2E'],
  )
}
