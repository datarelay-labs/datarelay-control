#!/usr/bin/env npx tsx
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readJson, suitePath } from '../lib/io.js'

const REQUIRED_CATEGORIES = [
  'source_auth',
  'destination',
  'transform',
  'governance',
  'route',
  'runtime',
]

const REQUIRED_PURPOSES = [
  'HTTP No Auth',
  'HTTP Basic',
  'HTTP Bearer',
  'HTTP API Key Header',
  'HTTP API Key Query',
  'PostgreSQL credential',
  'S3 credential',
  'SFTP password',
  'Webhook Receiver',
  'Webhook destination',
  'Syslog UDP',
  'Syslog TCP',
  'Syslog TLS',
  'Basic Field Mapping',
  'JSONata 단일 필드',
  'JSONata 중첩 객체',
  'JSONata 배열 처리',
  'Regex match/replace',
  'Regex no-match',
  'Timestamp UTC',
  'Timestamp offset',
  'Timestamp invalid',
  'Schema Drift Allow',
  'Schema Drift Warn',
  'Schema Drift Block',
  'Unknown Field Pass Through',
  'Unknown Field Drop',
  'Unknown Field Block',
  'Confidential Detection',
  'Mask partial',
  'Mask full',
  'Tokenize',
  'Hash',
  'Remove',
  'Quarantine',
  'Block',
  'Global Mapping 상속',
  'Route Mapping Override',
  'Destination A/B',
  'Route A Continue',
  'Protection 차등',
  'route-on',
  'Checkpoint',
  'Incremental',
  'Dedup',
  'Replay',
  'Collector 실패',
  'Retry/Recovery',
]

export function validateGoldenCoverage(): {
  status: 'PASS' | 'FAIL'
  total: number
  missing_purpose_substrings: string[]
  missing_categories: string[]
} {
  const catalog = readJson<{ scenarios: { purpose: string; category: string }[] }>(
    suitePath('golden', 'golden-scenarios.json'),
  )
  const purposes = catalog.scenarios.map((s) => s.purpose)
  const categories = new Set(catalog.scenarios.map((s) => s.category))
  const missing_purpose_substrings = REQUIRED_PURPOSES.filter((p) => !purposes.some((x) => x.includes(p)))
  const missing_categories = REQUIRED_CATEGORIES.filter((c) => !categories.has(c))
  return {
    status: missing_purpose_substrings.length || missing_categories.length ? 'FAIL' : 'PASS',
    total: catalog.scenarios.length,
    missing_purpose_substrings,
    missing_categories,
  }
}

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].endsWith('validate-golden-coverage.ts'))

if (isMain) {
  const r = validateGoldenCoverage()
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.status === 'PASS' ? 0 : 1)
}
