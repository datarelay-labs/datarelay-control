import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const consoleSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/streams/streams-console.tsx'),
  'utf8',
)
const detailSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/streams/stream-console-detail-panel.tsx'),
  'utf8',
)

describe('M7 narrow-screen source contract', () => {
  it('stacks the Streams console and detail panel before the desktop breakpoint', () => {
    expect(consoleSource).toContain(
      'flex w-full min-w-0 flex-col items-stretch gap-0 lg:flex-row lg:items-start',
    )
  })

  it('keeps the detail panel within a 320px viewport and restores the desktop rail only at lg', () => {
    expect(detailSource).toContain('w-full min-w-0 max-w-full')
    expect(detailSource).toContain('lg:w-[400px] lg:min-w-[340px]')
    expect(detailSource).not.toContain(
      'sticky top-0 self-start flex w-[400px] min-w-[340px]',
    )
  })
})
