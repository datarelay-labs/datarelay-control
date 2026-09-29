import {
  ArrowRightLeft,
  Calculator,
  ChevronDown,
  Code2,
  GitBranch,
  Plus,
  Regex,
  Tag,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'

export type TransformLauncherAction =
  | 'map_rename'
  | 'static'
  | 'calculated'
  | 'normalize'
  | 'conditional'
  | 'jsonata'
  | 'regex'

type TransformLauncherItem = {
  action: TransformLauncherAction
  label: string
  description: string
  icon: typeof Plus
  group: 'guided' | 'advanced'
}

const ITEMS: readonly TransformLauncherItem[] = [
  {
    action: 'map_rename',
    label: 'Map / rename field',
    description: 'Choose a source field and name it in the final event',
    icon: ArrowRightLeft,
    group: 'guided',
  },
  {
    action: 'static',
    label: 'Add fixed value',
    description: 'Add a constant field such as vendor, product, or tenant',
    icon: Tag,
    group: 'guided',
  },
  {
    action: 'calculated',
    label: 'Calculate field',
    description: 'Derive a value from fields already in the event',
    icon: Calculator,
    group: 'guided',
  },
  {
    action: 'normalize',
    label: 'Normalize field',
    description: 'Standardize timestamps or text formatting',
    icon: Zap,
    group: 'guided',
  },
  {
    action: 'conditional',
    label: 'Conditional field',
    description: 'Set a value only when matching conditions are met',
    icon: GitBranch,
    group: 'guided',
  },
  {
    action: 'jsonata',
    label: 'JSONata',
    description: 'Advanced full-event expression transform',
    icon: Code2,
    group: 'advanced',
  },
  {
    action: 'regex',
    label: 'Regex',
    description: 'Expert full-event regex transform configuration',
    icon: Regex,
    group: 'advanced',
  },
] as const

export function TransformRuleLauncher({
  onSelect,
  className,
}: {
  onSelect: (action: TransformLauncherAction) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const choose = (action: TransformLauncherAction) => {
    onSelect(action)
    setOpen(false)
  }

  const renderGroup = (group: TransformLauncherItem['group']) =>
    ITEMS.filter((item) => item.group === group).map((item) => {
      const Icon = item.icon
      return (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          onClick={() => choose(item.action)}
          data-testid={`transform-launcher-${item.action}`}
          className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-gdc-rowHover dark:focus-visible:bg-gdc-rowHover"
        >
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200/90 bg-slate-50 text-slate-600 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong">
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold text-slate-900 dark:text-gdc-foreground">{item.label}</span>
            <span className="mt-0.5 block text-[10px] leading-snug text-slate-500 dark:text-gdc-muted">{item.description}</span>
          </span>
        </button>
      )
    })

  return (
    <div ref={menuRef} className={cn('relative shrink-0', className)} data-testid="transform-rule-launcher">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-gdc-primary px-3 text-[12px] font-semibold text-white shadow-sm hover:opacity-90"
        data-testid="transform-rule-launcher-trigger"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add transform
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Add transform"
          className="absolute right-0 z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200/90 bg-white py-1 shadow-xl dark:border-gdc-border dark:bg-gdc-card"
        >
          <p className="px-3 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-gdc-placeholder">
            Guided
          </p>
          {renderGroup('guided')}
          <div className="my-1 border-t border-slate-200/80 dark:border-gdc-border" />
          <p className="px-3 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-gdc-placeholder">
            Full-event editors
          </p>
          {renderGroup('advanced')}
        </div>
      ) : null}
    </div>
  )
}
