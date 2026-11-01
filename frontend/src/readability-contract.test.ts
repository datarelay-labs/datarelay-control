import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8')
const tokensCss = fs.readFileSync(path.resolve(process.cwd(), 'src/foundation-semantic-tokens.css'), 'utf8')

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

describe('Dark theme root and wordmark contrast contract', () => {
  const root = postcss.parse(css)

  function rulesWithSelector(selector: string): postcss.Rule[] {
    const rules: postcss.Rule[] = []
    root.walkRules((rule) => {
      if (rule.selectors.includes(selector)) rules.push(rule)
    })
    return rules
  }

  it('applies every html.dark rule to the data-dr-theme marker the shell actually sets on <html>', () => {
    const legacyRules = rulesWithSelector('html.dark')
    expect(legacyRules.length).toBeGreaterThanOrEqual(3)
    for (const rule of legacyRules) {
      expect(rule.selectors).toContain('html[data-dr-theme="dark"]')
    }
    const declared: string[] = []
    for (const rule of rulesWithSelector('html[data-dr-theme="dark"]')) {
      rule.walkDecls((decl) => {
        declared.push(decl.prop)
      })
    }
    expect(declared).toEqual(expect.arrayContaining(['color-scheme', '--gdc-chart-muted', 'background']))
  })

  it('gives the "Data" half of the shell wordmark an explicit theme-aware brand colour', () => {
    const rules = rulesWithSelector('.dr-shell__wordmark > span:not(.dr-shell__wordmark-relay)')
    expect(rules).toHaveLength(1)
    let color: string | undefined
    for (const rule of rules) {
      rule.walkDecls('color', (decl) => {
        color = decl.value
      })
    }
    expect(color).toBe('var(--dr-brand-data)')
    expect(tokensCss).toMatch(/:root,\s*\[data-dr-theme="light"\]\s*\{[^}]*--dr-brand-data:\s*oklch\(21%/)
    expect(tokensCss).toMatch(/\[data-dr-theme="dark"\]\s*\{[^}]*--dr-brand-data:\s*oklch\(97%/)
  })
})
