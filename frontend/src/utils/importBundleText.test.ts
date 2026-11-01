import { describe, expect, it } from 'vitest'
import { parseImportBundleText } from './importBundleText'

describe('parseImportBundleText', () => {
  it('accepts a JSON object', () => {
    const res = parseImportBundleText('{"version":2,"connectors":[]}')
    expect(res).toEqual({ ok: true, bundle: { version: 2, connectors: [] } })
  })

  it('explains an empty file instead of leaving the action silently disabled', () => {
    const res = parseImportBundleText('   \n')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/empty/i)
  })

  it('never shows the raw JSON engine message for invalid or truncated text', () => {
    for (const text of ['this is not json {', '{"version":2,"connectors":[{"name":"abc']) {
      const res = parseImportBundleText(text)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).not.toMatch(/Unexpected token|Unterminated|position \d+|is not valid JSON$/)
        expect(res.message).toMatch(/not valid JSON/i)
      }
    }
  })

  it('rejects arrays and scalars with a specific sentence instead of an API schema error', () => {
    for (const text of ['[]', '"x"', '42', 'null']) {
      const res = parseImportBundleText(text)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/JSON object/)
        expect(res.message).not.toMatch(/valid dictionary/i)
      }
    }
  })
})
