import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { buttonClassName, type ButtonSize, type ButtonVariant } from './button-classes'

export type { ButtonSize, ButtonVariant } from './button-classes'

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  /** Disables the button, sets aria-busy and replaces the leading icon with a spinner. */
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  leadingIcon,
  trailingIcon,
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const leading = loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" data-button-spinner="" /> : leadingIcon
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClassName({ variant, size, className })}
    >
      {leading ? <span className="inline-flex shrink-0 items-center" aria-hidden="true">{leading}</span> : null}
      {children}
      {trailingIcon ? <span className="inline-flex shrink-0 items-center" aria-hidden="true">{trailingIcon}</span> : null}
    </button>
  )
}
