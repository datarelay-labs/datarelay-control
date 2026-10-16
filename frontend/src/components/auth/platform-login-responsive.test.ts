import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

function mobileLoginStyle(selector: string, property: string) {
  const css = postcss.parse(readFileSync(process.env.GDC_LOGIN_CSS_UNDER_TEST ?? 'src/index.css', 'utf8'))
  let order: string | undefined
  css.walkAtRules('media', (media) => {
    if (!media.params.includes('max-width: 640px')) return
    media.walkRules(selector, (rule) => {
      rule.walkDecls(property, (decl) => { order = decl.value })
    })
  })
  return order
}

describe('Control mobile login first-fold layout', () => {
  it('compacts resource links while keeping visual and keyboard DOM order aligned', () => {
    expect(mobileLoginStyle('.gdc-login-centered .dr-auth-layout__resources', 'grid-template-columns'))
      .toBe('repeat(2, minmax(0, 1fr))')
    expect(mobileLoginStyle('.gdc-login-centered .dr-auth-layout__resources a', 'padding'))
      .toBe('4px 6px')
    expect(mobileLoginStyle('.gdc-login-centered .dr-auth-layout__resources small', 'display'))
      .toBe('none')
    expect(mobileLoginStyle('.gdc-login-centered .dr-auth-card', 'order')).toBeUndefined()
  })
})
