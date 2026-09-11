/**
 * Validate real-apps candidate manifest + sanitization self-check.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { loadRules, sanitizeCapture } from './sanitize-capture.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function main(): void {
  const candidatesPath = path.join(__dirname, 'candidates.yaml')
  const doc = parseYaml(fs.readFileSync(candidatesPath, 'utf8')) as {
    version: number
    priority_model?: { dimensions: string[] }
    candidates: Array<{
      id: string
      priority?: string
      recommendation: string
      enabled: boolean
      product_auth_mapping?: string | string[]
      unsupported_product_flows?: string[]
    }>
  }
  assert.ok(Array.isArray(doc.candidates))
  assert.ok(doc.candidates.length >= 10)
  assert.equal(doc.version, 2)
  assert.ok(doc.priority_model?.dimensions?.includes('AUTH_COVERAGE'))

  const ids = new Set(doc.candidates.map((c) => c.id))
  for (const required of [
    'frappe_erpnext',
    'wordpress',
    'salesforce',
    'shopify',
    'openweather',
    'github',
    'neon_postgresql',
    'hubspot',
    'stripe',
    'atlassian_jira',
    'okta',
    'microsoft_365',
  ]) {
    assert.ok(ids.has(required), `missing candidate ${required}`)
  }

  const byPriority = (p: string) => doc.candidates.filter((c) => c.priority === p).map((c) => c.id)
  const p0 = byPriority('P0')
  assert.ok(p0.includes('frappe_erpnext'))
  assert.ok(p0.includes('wordpress'))
  assert.ok(p0.includes('openweather'))
  assert.ok(p0.includes('neon_postgresql'))

  const qbo = doc.candidates.find((c) => c.id === 'quickbooks')
  assert.equal(qbo?.product_auth_mapping, 'NOT_IMPLEMENTED')
  assert.ok(qbo?.unsupported_product_flows?.includes('oauth2_authorization_code'))

  assert.equal(doc.candidates.every((c) => c.enabled === false), true, 'no live candidates enabled by default')

  const rules = loadRules()
  const cleaned = sanitizeCapture(
    {
      headers: { Authorization: 'Bearer abc', Cookie: 'a=1' },
      email: 'a@b.com',
      access_token: 'secret',
      nested: { refresh_token: 'r', phone: '415-555-1212' },
    },
    rules,
  ) as Record<string, unknown>
  const headers = cleaned.headers as Record<string, unknown>
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers.Cookie, undefined)
  assert.equal(cleaned.email, rules.replacement_defaults.email)
  assert.equal(cleaned.access_token, rules.replacement_defaults.token)

  const envExample = path.join(__dirname, '.env.real-apps.example')
  assert.ok(fs.existsSync(envExample))
  assert.ok(fs.existsSync(path.join(__dirname, 'frappe', 'docker-compose.yml')))
  assert.ok(fs.existsSync(path.join(__dirname, 'wordpress', 'docker-compose.yml')))

  console.log(
    JSON.stringify(
      {
        ok: true,
        candidateCount: doc.candidates.length,
        p0: byPriority('P0'),
        p1: byPriority('P1'),
        p2: byPriority('P2'),
        recommended: doc.candidates.filter((c) => c.recommendation === 'recommended').map((c) => c.id),
        liveValidated: 0,
        status: 'UNCONFIGURED',
      },
      null,
      2,
    ),
  )
}

main()
