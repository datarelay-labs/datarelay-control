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
    candidates: Array<{ id: string; recommendation: string; enabled: boolean }>
  }
  assert.ok(Array.isArray(doc.candidates))
  assert.ok(doc.candidates.length >= 10)
  const ids = new Set(doc.candidates.map((c) => c.id))
  assert.ok(ids.has('hubspot'))
  assert.ok(ids.has('stripe'))
  assert.ok(ids.has('shopify'))
  assert.ok(ids.has('microsoft_365'))
  assert.equal(doc.candidates.every((c) => c.enabled === false), true, 'no live candidates enabled by default')

  const rules = loadRules()
  const cleaned = sanitizeCapture({
    headers: { Authorization: 'Bearer abc', Cookie: 'a=1' },
    email: 'a@b.com',
    access_token: 'secret',
    nested: { refresh_token: 'r', phone: '415-555-1212' },
  }, rules) as Record<string, unknown>
  const headers = cleaned.headers as Record<string, unknown>
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers.Cookie, undefined)
  assert.equal(cleaned.email, rules.replacement_defaults.email)
  assert.equal(cleaned.access_token, rules.replacement_defaults.token)

  const envExample = path.join(__dirname, '.env.real-apps.example')
  assert.ok(fs.existsSync(envExample))

  console.log(
    JSON.stringify(
      {
        ok: true,
        candidateCount: doc.candidates.length,
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
