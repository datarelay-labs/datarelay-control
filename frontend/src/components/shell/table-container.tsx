import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

type TableContainerProps = HTMLAttributes<HTMLDivElement>

export function TableContainer({ className, ...rest }: TableContainerProps) {
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card',
        className,
      )}
      {...rest}
    />
  )
}
