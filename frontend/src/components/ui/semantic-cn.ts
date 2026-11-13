import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * Default tailwind-merge treats unknown `text-*` utilities as colours, so
 * `text-caption text-fg-muted` would silently drop the type role. Register the
 * semantic type, control-height and border aliases from tailwind.config.js so
 * they merge in their real groups.
 */
const twMergeSemantic = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['caption', 'body-sm', 'body', 'label', 'title-sm', 'title', 'page-title', 'metric'] }],
      h: [{ h: ['control-sm', 'control-md', 'control-touch'] }],
      'min-h': [{ 'min-h': ['control-sm', 'control-md', 'control-touch'] }],
      'border-color': [{ border: ['default', 'strong'] }],
    },
  },
})

/** `cn` for primitives built on the semantic aliases. */
export function semanticCn(...inputs: ClassValue[]) {
  return twMergeSemantic(clsx(inputs))
}
