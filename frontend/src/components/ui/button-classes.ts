import type { ClassValue } from 'clsx'
import { semanticCn } from './semantic-cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'touch'

/**
 * Primary hover darkens via brightness instead of bg-accent-hover: the dark-theme
 * hover token is lighter and fails contrast under white text. Danger uses the
 * subtle critical pair because white on the dark-theme critical red fails contrast.
 */
const variantClass: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-on-accent hover:brightness-90',
  secondary: 'border-default bg-surface-card text-fg hover:bg-surface-hover',
  ghost: 'border-transparent bg-transparent text-fg-secondary hover:bg-surface-hover hover:text-fg',
  danger: 'border-status-critical-border bg-status-critical-subtle text-status-critical hover:brightness-95',
}

/** Body type at every size: the M7-02 readability floor pins operable controls to 14px. */
const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-control-sm gap-1.5 px-3',
  md: 'h-control-md gap-2 px-4',
  touch: 'h-control-touch gap-2 px-4',
}

/** Shared button styling, also usable on router links that must look like buttons. */
export function buttonClassName({
  variant = 'secondary',
  size = 'md',
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: ClassValue } = {}): string {
  return semanticCn(
    'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md border text-body font-medium',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
    'disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
    variantClass[variant],
    sizeClass[size],
    className,
  )
}
