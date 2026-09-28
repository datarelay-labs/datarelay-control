import assert from 'node:assert/strict'
import fs from 'node:fs'

const mainUrl = new URL('./cli/main.ts', import.meta.url)
const pageUrl = new URL('./pages/streams.page.ts', import.meta.url)
const main = fs.readFileSync(mainUrl, 'utf8')
const streamsPage = fs.readFileSync(pageUrl, 'utf8')

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0, `missing section start: ${start}`)
  assert.ok(to > from, `missing section end: ${end}`)
  return source.slice(from, to)
}

const stopStart = section(main, '// ---- stop/start browser lifecycle ----', '// ---- delete while running ----')
assert.doesNotMatch(stopStart, /api\.stopStream\(primaryHttp\)/)
assert.doesNotMatch(stopStart, /api\.startStream\(primaryHttp\)/)
assert.match(stopStart, /await streamsPg\.openRuntime\(primaryHttp\)/)
assert.match(stopStart, /const stopClicked = await streamsPg\.clickStop\(\)/)
assert.match(stopStart, /const startClicked = await streamsPg\.clickStart\(\)/)
assert.match(stopStart, /startedApi = startClicked &&/)

const startStreams = section(main, '// ---- start streams (browser first) ----', '// ---- actual delivery')
assert.match(startStreams, /const targetIds = \[\.\.\.new Set\(/)
assert.match(startStreams, /await streams\.openRuntime\(id\)/)
assert.doesNotMatch(startStreams, /await streams\.openStreamByName\(sname\)/)
const deleteLifecycle = section(main, '// ---- full delete lifecycle', "store.setFlag('ACTUAL_DELIVERY_TESTS'")
assert.doesNotMatch(deleteLifecycle, /api\.stopStream\(deleteLifecycleId\)/)
assert.doesNotMatch(deleteLifecycle, /api\.deleteStream\(deleteLifecycleId\)/)
assert.match(deleteLifecycle, /browserDeleteOk = del\.deleteClicked && del\.confirmClicked && gone/)
assert.match(deleteLifecycle, /FULL_CREATE_TO_DELETE_BROWSER_LIFECYCLE', browserDeleteOk \? 'PASS' : 'FAIL'/)

assert.match(main, /return finalAcceptanceBlocked\(store\) \? 1 : 0/)
assert.match(main, /const status = browserComplete \? 'PASS' : idsPresent \? 'PARTIAL' : 'FAIL'/)
assert.match(main, /const ok = failVisible && passVisible/)
assert.match(main, /const isolationOk = browserEditOk && persistOk && aOk && !bOk/)
assert.match(main, /browserRecoveryOk \? 'PASS' : recA && recB && recoveryApiFallback \? 'PARTIAL' : 'FAIL'/)

assert.match(streamsPage, /clickStart\(\): Promise<boolean>/)
assert.match(streamsPage, /clickStop\(\): Promise<boolean>/)
assert.match(streamsPage, /deleteClicked: boolean; confirmClicked: boolean/)

console.log('browser-authority contract PASS')
