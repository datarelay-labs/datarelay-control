import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/foundation-semantic-tokens.css'), 'utf8')

describe('Product Foundation semantic-token compatibility slice', () => {
  it('is additive custom-property mapping only', () => {
    const declarations = css
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith(';'))

    expect(declarations.length).toBeGreaterThan(40)
    expect(declarations.every((line) => line.startsWith('--dr-'))).toBe(true)
    expect(css).toContain('[data-dr-theme="light"]')
    expect(css).toContain('[data-dr-theme="dark"]')
  })

  it('exposes the Control shell geometry through Foundation semantic names', () => {
    expect(css).toContain('--dr-layout-sidebar-expanded: 260px;')
    expect(css).toContain('--dr-layout-sidebar-collapsed: 57px;')
    expect(css).toContain('--dr-font-size-base: 14px;')
    expect(css).toContain('--dr-radius-card: 8px;')
  })
})
