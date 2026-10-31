import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/streams/stream-console-detail-panel.tsx'),
  'utf8',
)

function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

function toneClassStrings(name: string): string[] {
  return [...functionBody(name).matchAll(/'([^']*\b(?:bg|text|border)-[^']*)'/g)].map((m) => m[1])
}

// Dark-only surfaces and -400 text are unreadable on the white light-theme panel.
const DARK_ONLY_TOKEN = /^(?:bg-(?:emerald|amber|red|slate)-(?:900|950)(?:\/\d+)?|text-(?:emerald|amber|red|slate)-400)$/

describe('Stream console detail panel status tones', () => {
  it.each(['streamStatusToneClass', 'routeStatusToneClass'])(
    '%s pairs every dark-only tone with a dark: variant and a light-theme default',
    (name) => {
      const classStrings = toneClassStrings(name)
      expect(classStrings.length).toBeGreaterThanOrEqual(4)
      for (const classes of classStrings) {
        const tokens = classes.split(/\s+/)
        expect(tokens.filter((token) => DARK_ONLY_TOKEN.test(token))).toEqual([])
        expect(tokens.some((token) => /^text-(?:emerald|amber|red|slate)-(?:600|700|800)$/.test(token))).toBe(true)
        expect(tokens.some((token) => token.startsWith('dark:text-'))).toBe(true)
        expect(tokens.some((token) => token.startsWith('dark:bg-'))).toBe(true)
      }
    },
  )
})
