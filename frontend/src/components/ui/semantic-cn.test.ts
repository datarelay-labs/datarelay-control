import { describe, expect, it } from 'vitest'
import { semanticCn } from './semantic-cn'

describe('semanticCn', () => {
  it('keeps a semantic type role next to a semantic text colour', () => {
    expect(semanticCn('text-caption', 'text-fg-muted').split(' ')).toEqual(['text-caption', 'text-fg-muted'])
    expect(semanticCn('text-metric', 'text-status-unknown').split(' ')).toEqual(['text-metric', 'text-status-unknown'])
  })

  it('resolves conflicts within the type, height and border-colour groups', () => {
    expect(semanticCn('text-caption', 'text-body-sm')).toBe('text-body-sm')
    expect(semanticCn('text-body', 'text-sm')).toBe('text-sm')
    expect(semanticCn('h-control-sm', 'h-control-touch')).toBe('h-control-touch')
    expect(semanticCn('border-default', 'border-transparent')).toBe('border-transparent')
    expect(semanticCn('border', 'border-default').split(' ')).toEqual(['border', 'border-default'])
  })
})
