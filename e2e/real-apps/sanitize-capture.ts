/**
 * Sanitize captured HTTP request/response JSON before committing as WireMock fixtures.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export type SanitizeRules = {
  replacement_defaults: Record<string, string>
  remove_header_names: string[]
  redact_key_patterns: string[]
  email_pattern: string
  phone_pattern: string
}

export function loadRules(rulesPath = path.join(__dirname, 'sanitization-rules.yaml')): SanitizeRules {
  return parseYaml(fs.readFileSync(rulesPath, 'utf8')) as SanitizeRules
}

function keyMatches(key: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(key))
}

export function sanitizeValue(value: unknown, rules: SanitizeRules, keyHint = ''): unknown {
  const keyRes = rules.redact_key_patterns.map((p) => new RegExp(p, 'i'))
  const emailRe = new RegExp(rules.email_pattern, 'gi')
  const phoneRe = new RegExp(rules.phone_pattern, 'g')
  const removeHeaders = new Set(rules.remove_header_names.map((h) => h.toLowerCase()))

  if (typeof value === 'string') {
    if (keyMatches(keyHint, keyRes)) return rules.replacement_defaults.token || 'token-redacted'
    let out = value.replace(emailRe, rules.replacement_defaults.email)
    out = out.replace(phoneRe, rules.replacement_defaults.phone)
    return out
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, rules, keyHint))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.toLowerCase() === 'headers' && v && typeof v === 'object') {
        const headers: Record<string, unknown> = {}
        for (const [hk, hv] of Object.entries(v as Record<string, unknown>)) {
          if (removeHeaders.has(hk.toLowerCase())) continue
          headers[hk] = sanitizeValue(hv, rules, hk)
        }
        out[k] = headers
        continue
      }
      if (keyMatches(k, keyRes)) {
        if (/email/i.test(k)) out[k] = rules.replacement_defaults.email
        else if (/phone|mobile/i.test(k)) out[k] = rules.replacement_defaults.phone
        else if (/name/i.test(k)) out[k] = rules.replacement_defaults.person_name
        else if (/tenant/i.test(k)) out[k] = rules.replacement_defaults.tenant
        else if (/account/i.test(k)) out[k] = rules.replacement_defaults.account_id
        else if (/key/i.test(k)) out[k] = rules.replacement_defaults.api_key
        else out[k] = rules.replacement_defaults.token
        continue
      }
      out[k] = sanitizeValue(v, rules, k)
    }
    return out
  }
  return value
}

export function sanitizeCapture(input: unknown, rules = loadRules()): unknown {
  return sanitizeValue(input, rules)
}

function main(): void {
  const argv = process.argv.slice(2)
  const inIdx = argv.indexOf('--in')
  const outIdx = argv.indexOf('--out')
  if (inIdx < 0 || outIdx < 0) {
    // Self-check mode
    const sample = {
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: {
        email: 'alice@corp.example',
        access_token: 'tok_live_abc',
        phone: '+1-415-555-0199',
        name: 'Alice Example',
        tenant_id: 'ten_real_99',
        orders: [{ id: 1, total: 12.5 }],
      },
    }
    const cleaned = sanitizeCapture(sample)
    console.log(JSON.stringify({ ok: true, mode: 'self-check', cleaned }, null, 2))
    return
  }
  const inputPath = argv[inIdx + 1]
  const outputPath = argv[outIdx + 1]
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  const cleaned = sanitizeCapture(raw)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(cleaned, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, outputPath }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
