import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}
const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'src/main.tsx'), 'utf8')
const shellSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/layout/app-shell-layout.tsx'),
  'utf8',
)

describe('M7 Foundation visual adoption contract', () => {
  it('keeps the exact shared Foundation visual packages pinned', () => {
    for (const name of [
      '@datarelay-labs/ui',
      '@datarelay-labs/product-shell',
      '@datarelay-labs/tokens',
    ]) {
      expect(packageJson.dependencies?.[name]).toBe('0.1.0-rc.41')
    }
  })

  it('loads shared styles and the shared ThemeRoot instead of a parallel shell theme', () => {
    expect(mainSource).toContain("import '@datarelay-labs/ui/styles.css'")
    expect(mainSource).toContain("import '@datarelay-labs/product-shell/styles.css'")
    expect(mainSource).toContain("import './foundation-semantic-tokens.css'")
    expect(shellSource).toContain("import { ThemeRoot } from '@datarelay-labs/ui'")
    expect(shellSource).toContain('<ThemeRoot theme={isDark ? \'dark\' : \'light\'}')
  })
})
