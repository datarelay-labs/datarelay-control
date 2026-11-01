import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/foundation-semantic-tokens.css'), 'utf8')
const tailwindConfig = fs.readFileSync(path.resolve(process.cwd(), 'tailwind.config.js'), 'utf8')

function themeBlock(selector: RegExp): Map<string, string> {
  const body = css.match(selector)?.[1]
  if (body === undefined) throw new Error(`theme block not found: ${selector}`)
  const tokens = new Map<string, string>()
  for (const [, name, value] of body.matchAll(/^\s*(--dr-[a-z0-9-]+):\s*(.+);\s*$/gm)) tokens.set(name, value)
  return tokens
}

const light = themeBlock(/:root,\s*\[data-dr-theme="light"\]\s*\{([^}]*)\}/)
const dark = themeBlock(/\[data-dr-theme="dark"\]\s*\{([^}]*)\}/)

function token(theme: Map<string, string>, name: string): string {
  const value = theme.get(name)
  if (value === undefined) throw new Error(`missing token ${name}`)
  return value
}

/** Linear-light sRGB channels for `#rrggbb` or `oklch(L% C H)`, clamped to the sRGB gamut. */
function linearRgb(value: string): [number, number, number] {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    return [0, 2, 4].map((i) => {
      const c = parseInt(hex[1].slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
  }
  const oklch = value.match(/^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$/)
  if (!oklch) throw new Error(`unsupported colour ${value}`)
  const L = Number(oklch[1]) / 100
  const C = Number(oklch[2])
  const h = (Number(oklch[3]) * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function relativeLuminance(value: string): number {
  const [r, g, b] = linearRgb(value)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(foreground: string, background: string): number {
  const [hi, lo] = [relativeLuminance(foreground), relativeLuminance(background)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const STATUS_FAMILIES = ['success', 'warning', 'critical', 'info', 'unknown'] as const

/** Colour tokens are re-declared per theme so derived color-mix() values resolve against that theme. */
const NEW_COLOUR_TOKENS = [
  '--dr-text-on-accent',
  '--dr-status-unknown',
  ...STATUS_FAMILIES.flatMap((family) => [`--dr-status-${family}-subtle`, `--dr-status-${family}-border`]),
]

const TYPE_ROLES = ['caption', 'body-sm', 'body', 'label', 'title-sm', 'title', 'page-title', 'metric'] as const

/** Theme-independent geometry/type tokens live on :root and are inherited by the dark theme. */
const NEW_THEME_INDEPENDENT_TOKENS: Record<string, string> = {
  '--dr-control-sm': '32px',
  '--dr-control-md': '36px',
  '--dr-control-touch': '44px',
  ...Object.fromEntries(
    (
      [
        ['caption', 12, 16, 400],
        ['body-sm', 13, 18, 400],
        ['body', 14, 20, 400],
        ['label', 13, 16, 600],
        ['title-sm', 14, 20, 600],
        ['title', 16, 24, 600],
        ['page-title', 20, 28, 600],
        ['metric', 24, 32, 600],
      ] as const
    ).flatMap(([role, size, lineHeight, weight]) => [
      [`--dr-type-${role}-size`, `${size}px`],
      [`--dr-type-${role}-line-height`, `${lineHeight}px`],
      [`--dr-type-${role}-weight`, `${weight}`],
    ]),
  ),
}

const PRE_EXISTING_LIGHT_TOKENS = [
  'font-family-ui', 'font-size-xs', 'font-size-sm', 'font-size-base', 'font-size-lg', 'font-size-xl', 'font-size-2xl',
  'font-weight-regular', 'font-weight-medium', 'font-weight-strong', 'radius-control', 'radius-card', 'radius-pill',
  'space-1', 'space-2', 'space-3', 'space-4', 'space-5', 'space-6', 'space-8',
  'layout-sidebar-expanded', 'layout-sidebar-collapsed', 'layout-content-max', 'brand-mark', 'brand-relay', 'brand-data',
  'surface-page', 'surface-panel', 'surface-section', 'surface-card', 'surface-elevated', 'surface-overlay', 'surface-input',
  'surface-hover', 'border-default', 'border-strong', 'border-divider', 'border-input', 'text-primary', 'text-secondary',
  'text-muted', 'text-placeholder', 'text-inverse', 'action-primary', 'action-primary-hover', 'action-secondary',
  'action-secondary-hover', 'status-info', 'status-success', 'status-warning', 'status-critical', 'focus-ring',
].map((name) => `--dr-${name}`)

const PRE_EXISTING_DARK_TOKENS = [
  'brand-relay', 'brand-data', 'surface-page', 'surface-panel', 'surface-section', 'surface-card', 'surface-elevated',
  'surface-overlay', 'surface-input', 'surface-hover', 'border-default', 'border-strong', 'border-divider', 'border-input',
  'text-primary', 'text-secondary', 'text-muted', 'text-placeholder', 'text-inverse', 'action-primary',
  'action-primary-hover', 'action-secondary', 'action-secondary-hover', 'status-info', 'status-success', 'status-warning',
  'status-critical', 'focus-ring',
].map((name) => `--dr-${name}`)

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

  it('keeps every pre-existing token in both themes', () => {
    for (const name of PRE_EXISTING_LIGHT_TOKENS) expect(light.has(name), name).toBe(true)
    for (const name of PRE_EXISTING_DARK_TOKENS) expect(dark.has(name), name).toBe(true)
  })

  it('declares every new colour token in both themes', () => {
    for (const name of NEW_COLOUR_TOKENS) {
      expect(light.has(name), `light ${name}`).toBe(true)
      expect(dark.has(name), `dark ${name}`).toBe(true)
    }
    expect(token(light, '--dr-text-on-accent')).toBe('#ffffff')
    expect(token(dark, '--dr-text-on-accent')).toBe('#ffffff')
    expect(token(light, '--dr-status-unknown')).toBe('oklch(45% 0 0)')
    expect(token(dark, '--dr-status-unknown')).toBe('oklch(75% 0 0)')
  })

  it('derives subtle status surfaces and borders from the status foreground on the card surface', () => {
    for (const family of STATUS_FAMILIES) {
      const fg = `var(--dr-status-${family})`
      expect(token(light, `--dr-status-${family}-subtle`)).toBe(`color-mix(in oklab, ${fg} 8%, var(--dr-surface-card))`)
      expect(token(light, `--dr-status-${family}-border`)).toBe(`color-mix(in oklab, ${fg} 30%, var(--dr-surface-card))`)
      expect(token(dark, `--dr-status-${family}-subtle`)).toBe(`color-mix(in oklab, ${fg} 14%, var(--dr-surface-card))`)
      expect(token(dark, `--dr-status-${family}-border`)).toBe(`color-mix(in oklab, ${fg} 35%, var(--dr-surface-card))`)
    }
  })

  it('defines control heights and the type scale for both themes through :root', () => {
    for (const [name, value] of Object.entries(NEW_THEME_INDEPENDENT_TOKENS)) {
      expect(token(light, name), name).toBe(value)
      // The dark block must not fork theme-independent geometry.
      expect(dark.has(name), `dark ${name}`).toBe(false)
    }
  })

  it('meets WCAG AA text contrast for the corrected and accent tokens', () => {
    // Light muted text on the slate-100 surface (oklch 97%, also --dr-surface-section).
    expect(token(light, '--dr-surface-section')).toBe('oklch(97% 0 0)')
    expect(contrast(token(light, '--dr-text-muted'), token(light, '--dr-surface-section'))).toBeGreaterThanOrEqual(4.5)
    // Dark placeholder text on the dark input surface.
    expect(contrast(token(dark, '--dr-text-placeholder'), token(dark, '--dr-surface-input'))).toBeGreaterThanOrEqual(4.5)
    // Text on the primary accent in both themes.
    expect(contrast(token(light, '--dr-text-on-accent'), token(light, '--dr-action-primary'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token(dark, '--dr-text-on-accent'), token(dark, '--dr-action-primary'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token(light, '--dr-text-on-accent'), token(light, '--dr-action-primary-hover'))).toBeGreaterThanOrEqual(4.5)
  })
})

describe('Tailwind semantic aliases', () => {
  const EXPECTED_ALIASES = [
    "'surface-page': 'var(--dr-surface-page)'",
    "'surface-card': 'var(--dr-surface-card)'",
    "'surface-section': 'var(--dr-surface-section)'",
    "'surface-hover': 'var(--dr-surface-hover)'",
    "fg: 'var(--dr-text-primary)'",
    "'fg-secondary': 'var(--dr-text-secondary)'",
    "'fg-muted': 'var(--dr-text-muted)'",
    "'on-accent': 'var(--dr-text-on-accent)'",
    "accent: 'var(--dr-action-primary)'",
    "'accent-hover': 'var(--dr-action-primary-hover)'",
    "'focus-ring': 'var(--dr-focus-ring)'",
    ...STATUS_FAMILIES.flatMap((family) => [
      `'status-${family}': {`,
      `DEFAULT: 'var(--dr-status-${family})'`,
      `subtle: 'var(--dr-status-${family}-subtle)'`,
      `border: 'var(--dr-status-${family}-border)'`,
    ]),
    ...TYPE_ROLES.map(
      (role) =>
        `${role.includes('-') ? `'${role}'` : role}: ['var(--dr-type-${role}-size)', { lineHeight: 'var(--dr-type-${role}-line-height)', fontWeight: 'var(--dr-type-${role}-weight)' }]`,
    ),
    "'control-sm': 'var(--dr-control-sm)'",
    "'control-md': 'var(--dr-control-md)'",
    "'control-touch': 'var(--dr-control-touch)'",
  ]

  it('exposes the semantic colour, type and control-height aliases', () => {
    for (const snippet of EXPECTED_ALIASES) expect(tailwindConfig, snippet).toContain(snippet)
    expect(tailwindConfig).toMatch(/height:\s*\{\s*'control-sm'/)
    expect(tailwindConfig).toMatch(/minHeight:\s*\{\s*'control-sm'/)
  })

  it('exposes theme-aware border aliases', () => {
    expect(tailwindConfig).toMatch(
      /borderColor:\s*\{\s*default: 'var\(--dr-border-default\)',\s*strong: 'var\(--dr-border-strong\)',\s*\}/,
    )
  })

  it('points every --dr-* reference at a token that exists', () => {
    const references = [...tailwindConfig.matchAll(/var\((--dr-[a-z0-9-]+)\)/g)].map(([, name]) => name)
    expect(references.length).toBeGreaterThan(40)
    for (const name of references) expect(light.has(name), name).toBe(true)
    // Colour aliases must also resolve to a dark-theme value.
    for (const name of references.filter((ref) => !ref.startsWith('--dr-type-') && !ref.startsWith('--dr-control-'))) {
      expect(dark.has(name), `dark ${name}`).toBe(true)
    }
  })

  it('keeps every pre-existing Tailwind key and value', () => {
    for (const scale of ['slate', 'sky', 'violet']) {
      const body = tailwindConfig.match(new RegExp(`\\b${scale}: \\{([^}]*)\\}`))?.[1] ?? ''
      for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(body, `${scale}.${step}`).toMatch(new RegExp(`\\b${step}: 'oklch\\([^']+ / <alpha-value>\\)'`))
      }
    }
    for (const line of [
      "page: 'oklch(10% 0 0 / <alpha-value>)'",
      "bg: 'oklch(10% 0 0 / <alpha-value>)'",
      "panel: 'oklch(17% 0 0 / <alpha-value>)'",
      "section: 'oklch(15% 0 0 / <alpha-value>)'",
      "card: 'oklch(17% 0 0 / <alpha-value>)'",
      "cardHover: 'oklch(26.9% 0 0 / <alpha-value>)'",
      "elevated: 'oklch(12% 0 0 / <alpha-value>)'",
      "tableHeader: 'oklch(15% 0 0 / <alpha-value>)'",
      "rowHover: 'oklch(26.9% 0 0 / <alpha-value>)'",
      "row: 'oklch(26.9% 0 0 / <alpha-value>)'",
      "border: 'oklch(32% 0 0 / <alpha-value>)'",
      "borderStrong: 'oklch(37.1% 0 0 / <alpha-value>)'",
      "divider: 'oklch(26.9% 0 0 / <alpha-value>)'",
      "muted: 'oklch(70.8% 0 0 / <alpha-value>)'",
      "mutedStrong: 'oklch(98.5% 0 0 / <alpha-value>)'",
      "foreground: 'oklch(97% 0 0 / <alpha-value>)'",
      "placeholder: 'oklch(55.6% 0 0 / <alpha-value>)'",
      "input: 'oklch(21% 0.006 285.885 / <alpha-value>)'",
      "inputHover: 'oklch(26.9% 0 0 / <alpha-value>)'",
      "inputBorder: 'oklch(32% 0 0 / <alpha-value>)'",
      "primary: 'oklch(52% 0.209 260 / <alpha-value>)'",
      "critical: 'oklch(57.7% 0.245 27.325 / <alpha-value>)'",
      "criticalFg: 'oklch(97.1% 0.013 17.38 / <alpha-value>)'",
      "xs: ['12px', { lineHeight: 'calc(1 / 0.75)' }]",
      "sm: ['13px', { lineHeight: 'calc(1 / 0.85)' }]",
      "base: ['14px', { lineHeight: '1.5' }]",
      "lg: ['16px', { lineHeight: '1.5' }]",
      "bold: '600'",
      "xl: '0.5rem'",
      "'2xl': '0.5rem'",
      "'3xl': '0.5rem'",
      "colors: 'none'",
      "DEFAULT: 'none'",
      "sm: 'none'",
      "'gdc-card': 'none'",
      "'gdc-elevated': '0 12px 32px rgba(0, 0, 0, 0.38)'",
      "'gdc-control': 'none'",
      "'gdc-page-glow': 'none'",
      "darkMode: 'class'",
    ]) {
      expect(tailwindConfig, line).toContain(line)
    }
  })
})
