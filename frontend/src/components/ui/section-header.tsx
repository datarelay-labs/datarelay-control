import type { ReactNode } from 'react'
import { semanticCn } from './semantic-cn'

export type SectionHeadingLevel = 'h2' | 'h3' | 'h4'

export type SectionHeaderProps = {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned controls; wraps below the title on narrow widths. */
  actions?: ReactNode
  as?: SectionHeadingLevel
  /** Applied to the heading so a section can reference it via aria-labelledby. */
  id?: string
  className?: string
}

export function SectionHeader({ title, description, actions, as: Heading = 'h2', id, className }: SectionHeaderProps) {
  return (
    <div className={semanticCn('flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0 flex-1 basis-64">
        <Heading id={id} className="break-words text-title text-fg">
          {title}
        </Heading>
        {description ? <p className="mt-0.5 break-words text-body-sm text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
