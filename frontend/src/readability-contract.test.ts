import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8')

describe('M7 readable-workspace typography contract', () => {
  it('uses Foundation semantic font tokens for the product-wide readability floor', () => {
    expect(css).toContain('html[data-dr-theme] :where(')
    expect(css).toContain('[class~="text-[9px]"]')
    expect(css).toContain('[class~="text-[10px]"]')
    expect(css).toContain('[class~="text-[11px]"]')
    expect(css).toContain('font-size: var(--dr-font-size-xs);')
    expect(css).toContain('font-size: var(--dr-font-size-base);')
  })

  it('keeps technical code at the supporting floor while promoting operable controls and table data', () => {
    expect(css).toContain('button,')
    expect(css).toContain('input,')
    expect(css).toContain('select,')
    expect(css).toContain('textarea,')
    expect(css).toContain('[role="tab"],')
    expect(css).toContain('th,')
    expect(css).toContain('td')
    expect(css).toContain('html[data-dr-theme] :where(code, pre)')
  })
})
