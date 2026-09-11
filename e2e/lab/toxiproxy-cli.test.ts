/**
 * Toxiproxy CLI contract tests (no Docker required).
 * Verifies script presence, usage surface, and proxy config uniqueness.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function main(): void {
  const script = path.join(__dirname, 'fault-toxiproxy.sh')
  const compose = path.join(__dirname, 'docker-compose.toxiproxy.yml')
  const proxiesPath = path.join(__dirname, 'toxiproxy', 'proxies.json')
  assert.ok(fs.existsSync(script))
  assert.ok(fs.existsSync(compose))
  assert.ok(fs.existsSync(proxiesPath))

  const proxies = JSON.parse(fs.readFileSync(proxiesPath, 'utf8')) as Array<{ name: string; listen: string }>
  const listens = proxies.map((p) => p.listen)
  assert.equal(new Set(listens).size, listens.length, 'toxiproxy listen ports must be unique')
  assert.ok(proxies.some((p) => p.name === 'wiremock'))

  const help = spawnSync('bash', [script], { encoding: 'utf8' })
  assert.notEqual(help.status, 0)
  assert.match(help.stdout + help.stderr, /latency|timeout|reset/)

  // Without Toxiproxy up, start should fail deterministically (not hang).
  const start = spawnSync('bash', [script, 'start', 'latency', 'wiremock', '100', '0'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  assert.notEqual(start.status, 0)

  console.log(JSON.stringify({ ok: true, proxies: proxies.map((p) => p.name), decision: 'ADOPT_TEST_ONLY' }, null, 2))
}

main()
