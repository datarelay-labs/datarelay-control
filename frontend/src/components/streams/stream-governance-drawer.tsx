import { ChevronDown, ChevronUp, Shield, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { governanceWorkspacePath } from '../../config/nav-paths'
import { useGovernanceCapabilities } from '../../lib/governance-rbac'
import { cn } from '../../lib/utils'
import type { StreamGovernanceSnapshot } from '../../lib/stream-governance-snapshot'
import { SchemaDriftPanel } from './schema-drift-panel'
import { SensitiveFindingsPanel } from './sensitive-findings-panel'
import { ClassificationPanel } from './classification-panel'
import { ProtectionPanel } from './protection-panel'
import { PolicyPanel } from './policy-panel'
import { DynamicRoutingPanel } from './dynamic-routing-panel'
import { FailoverRoutingPanel } from './failover-routing-panel'
import { ReplayPanel } from './replay-panel'
import { QuarantinePanel } from './quarantine-panel'
import { SchemaDriftPolicyCard } from './schema-drift-policy-card'
import type { StreamSchemaDriftPolicyLabels } from '../../lib/stream-schema-drift-policy'

export type StreamGovernanceDrawerProps = {
  streamId: number | undefined
  canOperate: boolean
  schemaDriftPolicy?: StreamSchemaDriftPolicyLabels | null
  /** Page-owned governance summaries; panels skip duplicate summary GETs on first expand. */
  governanceSnapshot?: StreamGovernanceSnapshot | null
  /** Summary chips shown when collapsed */
  summaryChips?: { label: string; value: string; tone?: 'neutral' | 'warn' }[]
}

function DrawerPanelStack({ children }: { children: ReactNode }) {
  return <div className="space-y-3">{children}</div>
}

export function StreamGovernanceDrawer({
  streamId,
  canOperate,
  schemaDriftPolicy,
  governanceSnapshot,
  summaryChips,
}: StreamGovernanceDrawerProps) {
  const [expanded, setExpanded] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const canOpenGovernanceWorkspace = useGovernanceCapabilities().governance_read === true

  useEffect(() => {
    if (!expanded) setMobileOpen(false)
  }, [expanded])

  if (streamId == null) return null

  const chips = summaryChips ?? [
    { label: 'Governance', value: 'Data policy' },
  ]

  const panelContent = (
    <DrawerPanelStack>
      {canOpenGovernanceWorkspace ? (
        <Link
          to={governanceWorkspacePath({ stream_id: streamId })}
          data-testid="stream-governance-drawer-workspace-link"
          className="inline-flex text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
        >
          Open Governance Workspace
        </Link>
      ) : null}
      {schemaDriftPolicy ? <SchemaDriftPolicyCard policy={schemaDriftPolicy} /> : null}
      <SchemaDriftPanel
        streamId={streamId}
        canOperate={canOperate}
        initialSummary={governanceSnapshot?.schemaDrift}
      />
      <SensitiveFindingsPanel
        streamId={streamId}
        canOperate={canOperate}
        initialSummary={governanceSnapshot?.sensitive}
      />
      <ClassificationPanel streamId={streamId} />
      <ProtectionPanel
        streamId={streamId}
        canOperate={canOperate}
        initialSummary={governanceSnapshot?.protection}
      />
      <PolicyPanel streamId={streamId} initialSummary={governanceSnapshot?.policy} />
      <DynamicRoutingPanel streamId={streamId} initialSummary={governanceSnapshot?.dynamicRouting} />
      <FailoverRoutingPanel streamId={streamId} initialSummary={governanceSnapshot?.failover} />
      <ReplayPanel streamId={streamId} canOperate={canOperate} initialSummary={governanceSnapshot?.replay} />
      <QuarantinePanel
        streamId={streamId}
        canOperate={canOperate}
        initialSummary={governanceSnapshot?.quarantine}
      />
    </DrawerPanelStack>
  )

  return (
    <>
      {/* Desktop / tablet: right drawer rail */}
      <aside
        aria-label="Governance drawer"
        data-testid="stream-governance-drawer"
        className={cn(
          'hidden shrink-0 transition-[width] duration-200 md:block',
          expanded ? 'w-[min(360px,32vw)]' : 'w-12',
        )}
      >
        {!expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="sticky top-4 flex h-auto min-h-[12rem] w-12 flex-col items-center gap-2 rounded-l-xl border border-r-0 border-slate-200/80 bg-white py-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
            aria-expanded={false}
            title="Open Governance drawer"
          >
            <Shield className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
            <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500 [writing-mode:vertical-rl] dark:text-gdc-muted">
              Governance
            </span>
            <ChevronDown className="h-3.5 w-3.5 rotate-[-90deg] text-slate-400" aria-hidden />
          </button>
        ) : (
          <div className="sticky top-4 max-h-[calc(100vh-6rem)] overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
              <div className="flex items-center gap-1.5">
                <Shield className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
                <h3 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Governance</h3>
              </div>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200/90 text-slate-600 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-300 dark:hover:bg-gdc-rowHover"
                aria-label="Collapse Governance drawer"
              >
                <ChevronUp className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="flex flex-wrap gap-1 border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
              {chips.map((chip) => (
                <span
                  key={chip.label}
                  className={cn(
                    'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                    chip.tone === 'warn'
                      ? 'border-amber-300/80 bg-amber-500/10 text-amber-900 dark:border-amber-500/40 dark:text-amber-100'
                      : 'border-slate-200/90 bg-slate-50 text-slate-700 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-mutedStrong',
                  )}
                >
                  {chip.label}: {chip.value}
                </span>
              ))}
            </div>
            <div className="max-h-[calc(100vh-10rem)] overflow-y-auto p-3">{panelContent}</div>
          </div>
        )}
      </aside>

      {/* Tablet overlay when expanded on medium screens without side space */}
      {expanded ? (
        <div
          className="fixed inset-0 z-40 hidden bg-slate-950/40 md:block lg:hidden"
          role="presentation"
          onClick={() => setExpanded(false)}
          data-testid="stream-governance-drawer-overlay"
        />
      ) : null}

      {/* Mobile: bottom sheet */}
      <div className="md:hidden" data-testid="stream-governance-bottom-sheet">
        {!mobileOpen && !expanded ? (
          <button
            type="button"
            onClick={() => {
              setExpanded(true)
              setMobileOpen(true)
            }}
            className="fixed inset-x-3 bottom-3 z-30 flex items-center justify-between gap-2 rounded-xl border border-slate-200/90 bg-white/95 px-3 py-2.5 shadow-lg backdrop-blur dark:border-gdc-border dark:bg-gdc-card/95"
            aria-expanded={false}
          >
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-900 dark:text-slate-100">
              <Shield className="h-4 w-4 text-violet-600" aria-hidden />
              Governance
            </span>
            <span className="flex flex-wrap gap-1">
              {chips.slice(0, 2).map((chip) => (
                <span key={chip.label} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-gdc-elevated dark:text-gdc-muted">
                  {chip.value}
                </span>
              ))}
            </span>
            <ChevronUp className="h-4 w-4 text-slate-400" aria-hidden />
          </button>
        ) : null}

        {mobileOpen && expanded ? (
          <>
            <div className="fixed inset-0 z-40 bg-slate-950/50" role="presentation" onClick={() => { setExpanded(false); setMobileOpen(false) }} />
            <div
              role="dialog"
              aria-label="Governance drawer"
              className="fixed inset-x-0 bottom-0 z-50 flex max-h-[60vh] flex-col rounded-t-2xl border border-slate-200/90 bg-white shadow-2xl dark:border-gdc-border dark:bg-gdc-card"
            >
              <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-4 py-3 dark:border-gdc-border">
                <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Governance</h3>
                <button
                  type="button"
                  onClick={() => { setExpanded(false); setMobileOpen(false) }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gdc-rowHover"
                  aria-label="Close Governance drawer"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="flex flex-wrap gap-1 border-b border-slate-200/80 px-4 py-2 dark:border-gdc-border">
                {chips.map((chip) => (
                  <span key={chip.label} className="rounded-md border border-slate-200/90 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold dark:border-gdc-border dark:bg-gdc-elevated">
                    {chip.label}: {chip.value}
                  </span>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto p-3">{panelContent}</div>
            </div>
          </>
        ) : null}
      </div>
    </>
  )
}
