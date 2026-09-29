import { cn } from '../../lib/utils'

type DataRelayLogoMarkProps = {
  className?: string
  /** Accessible label; omit when decorative next to visible brand text. */
  'aria-label'?: string
}

/** Master DataRelay DR monogram. Shared with sidebar branding and favicon. */
export function DataRelayLogoMark({ className, 'aria-label': ariaLabel }: DataRelayLogoMarkProps) {
  return (
    <img
      src="/logo/datarelay-logo.svg?v=dr-monogram-6"
      alt={ariaLabel ?? ''}
      width={169}
      height={108}
      className={cn('shrink-0 object-contain', className)}
      draggable={false}
    />
  )
}

export function DataRelayWordmark({ className }: { className?: string }) {
  return (
    <p className={cn('text-2xl font-bold tracking-tight text-white sm:text-3xl', className)}>
      <span className="text-white">Data</span>
      <span className="text-emerald-400">Relay</span>
    </p>
  )
}
