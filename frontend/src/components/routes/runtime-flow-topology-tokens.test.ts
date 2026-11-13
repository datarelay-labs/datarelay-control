import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/components/routes/runtime-flow-topology.css'), 'utf8')
const edge = fs.readFileSync(path.resolve(process.cwd(), 'src/components/routes/runtime-flow-delivery-edge.tsx'), 'utf8')

describe('runtime flow topology uses product tokens', () => {
  it('has no hard-coded colour literals or decorative gradients', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/\brgba?\(/)
    expect(css).not.toMatch(/gradient\(/)
    expect(edge).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('derives every flow variable from a --dr-* token', () => {
    const root = css.slice(css.indexOf('.control-runtime-flow-root {'), css.indexOf('.control-runtime-flow-workspace {'))
    for (const name of ['--flow-ink', '--flow-muted', '--flow-border', '--flow-surface', '--flow-canvas', '--flow-highlight']) {
      expect(root, name).toMatch(new RegExp(name + ': var\\(--dr-'))
    }
    expect(css).toContain('var(--dr-status-success)')
    expect(css).toContain('var(--dr-status-critical)')
    expect(css).toContain('var(--dr-status-unknown)')
  })

  it('does not clip the canvas behind a horizontal scroll when the Inspector sits beside it', () => {
    expect(css).toMatch(/@media \(min-width: 1400px\)[\s\S]*?\.control-runtime-flow-canvas \{\s*min-width: 720px;/)
  })

  it('keeps the Inspector link a secondary action (one primary per view)', () => {
    const link = css.slice(css.indexOf('.control-runtime-flow-inspector-link {'), css.indexOf('.control-runtime-flow-inspector-hint {'))
    expect(link).not.toContain('--dr-action-primary')
    expect(link).toContain('var(--dr-surface-card)')
  })
})
