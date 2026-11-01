import { expect } from 'vitest'

/** Raw palette, dark-pair and arbitrary-size fragments that semantic-alias primitives must never emit. */
export const FORBIDDEN_CLASS_FRAGMENTS = ['dark:', 'emerald-', 'amber-', 'red-', 'slate-', 'text-['] as const

/** Every class attribute in the rendered tree (SVG `className` is not a string, so read the attribute). */
export function renderedClassNames(root: Element): string[] {
  return [root, ...Array.from(root.querySelectorAll('[class]'))]
    .map((element) => element.getAttribute('class') ?? '')
    .filter(Boolean)
}

export function expectOnlySemanticClasses(root: Element) {
  const classes = renderedClassNames(root)
  expect(classes.length).toBeGreaterThan(0)
  for (const className of classes) {
    for (const fragment of FORBIDDEN_CLASS_FRAGMENTS) {
      expect(className, `"${className}" must not contain "${fragment}"`).not.toContain(fragment)
    }
  }
}
