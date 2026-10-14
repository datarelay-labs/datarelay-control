import { CheckCircle2, ShieldCheck, Wand2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../../lib/utils'
import type { WizardDataProtectionState, WizardRouteDraft, WizardState } from '../wizard/wizard-state'
import { globalProtectionConfigured, globalTransformConfigured } from '../wizard/wizard-state'

import type { DestinationListItem } from '../../../api/gdcDestinations'
import { WizardSharedRuleImpact } from './wizard-shared-rule-impact'

export type SharedProcessingTab = 'transform' | 'data_protection'

type SharedCard = {
  key: SharedProcessingTab
  title: string
  description: string
  configured: boolean
  icon: typeof Wand2
}

const SHARED_TAB_DEFS: ReadonlyArray<{ key: SharedProcessingTab; label: string }> = [
  { key: 'transform', label: 'Transform' },
  { key: 'data_protection', label: 'Data Protection' },
]

function buildSharedCards(
  state: Pick<
    WizardState,
    'mapping' | 'transformRules' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson' | 'dataProtection'
  >,
): SharedCard[] {
  const transformOk = globalTransformConfigured(state)
  const protectionOk = globalProtectionConfigured(state.dataProtection)
  return [
    {
      key: 'transform',
      title: 'Transform',
      description: 'Mapping, transform rules, field operations.',
      configured: transformOk,
      icon: Wand2,
    },
    {
      key: 'data_protection',
      title: 'Data Protection',
      description: 'Schema drift policy, protection rules, delivery behavior.',
      configured: protectionOk,
      icon: ShieldCheck,
    },
  ]
}

/** @deprecated Use WizardSharedProcessingSection */
export const WizardGlobalProcessingSection = WizardSharedProcessingSection

export function WizardSharedProcessingSection({
  state,
  activeTab,
  onTabChange,
  children,
  routeCount = 0,
  routeDrafts,
  destinations = [],
  onSelectRoute,
}: {
  state: Pick<
    WizardState,
    | 'mapping'
    | 'transformRules'
    | 'mappingMode'
    | 'fullEventJsonataExpression'
    | 'fullEventRegexConfigJson'
    | 'dataProtection'
  >
  activeTab: SharedProcessingTab
  onTabChange: (tab: SharedProcessingTab) => void
  children?: ReactNode
  routeCount?: number
  routeDrafts?: readonly WizardRouteDraft[]
  destinations?: readonly Pick<DestinationListItem, 'id' | 'name'>[]
  onSelectRoute?: (key: string) => void
}) {
  const cards = buildSharedCards(state)

  return (
    <section className="space-y-3" data-testid="shared-processing-section">
      <article className="rounded-lg border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[14px] font-semibold text-slate-900 dark:text-slate-50">Shared Processing</h4>
            <span className="rounded-full border border-violet-300/70 bg-violet-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-800 dark:border-violet-500/40 dark:text-violet-200">
              Baseline
            </span>
          </div>
          <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">
            Configure shared defaults first — all routes inherit these settings unless overridden individually.
          </p>
          {routeCount > 0 ? (
            <p
              className="mt-1 text-[10px] font-semibold text-violet-700 dark:text-violet-300"
              data-testid="shared-processing-route-count"
            >
              {routeCount} Route{routeCount === 1 ? '' : 's'} in this flow
            </p>
          ) : null}
        </div>

        {routeDrafts ? <WizardSharedRuleImpact routes={routeDrafts} destinations={destinations}
          dataProtection={state.dataProtection} concern={activeTab} onSelectRoute={onSelectRoute} /> : null}

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {cards.map((card) => {
            const Icon = card.icon
            const active = activeTab === card.key
            return (
              <button
                key={card.key}
                type="button"
                onClick={() => onTabChange(card.key)}
                className={cn(
                  'rounded-lg border p-2.5 text-left transition-colors',
                  active
                    ? 'border-violet-400/80 bg-violet-500/[0.06] ring-1 ring-violet-400/40 dark:border-violet-500/50 dark:bg-violet-500/10'
                    : 'border-slate-200/90 bg-slate-50/50 hover:bg-slate-100/80 dark:border-gdc-border dark:bg-gdc-section/40 dark:hover:bg-gdc-rowHover',
                )}
                data-testid={`shared-processing-card-${card.key}`}
                aria-pressed={active}
              >
                <div className="flex items-start gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-700 dark:text-violet-300">
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">{card.title}</p>
                    <p className="mt-0.5 text-[9px] leading-snug text-slate-500 dark:text-gdc-muted">{card.description}</p>
                  </div>
                </div>
                <p
                  className={cn(
                    'mt-2 inline-flex items-center gap-1 text-[10px] font-semibold',
                    card.configured ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-gdc-muted',
                  )}
                >
                  {card.configured ? (
                    <>
                      <CheckCircle2 className="h-3 w-3" aria-hidden />
                      Configured
                    </>
                  ) : (
                    'Not configured'
                  )}
                </p>
              </button>
            )
          })}
        </div>

        <div
          className="mt-4 flex flex-wrap gap-1 border-b border-slate-100 dark:border-gdc-border"
          role="tablist"
          aria-label="Shared processing concerns"
          data-testid="shared-processing-tabs"
        >
          {SHARED_TAB_DEFS.map((tab) => {
            const active = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTabChange(tab.key)}
                className={cn(
                  '-mb-px border-b-2 px-3 pb-2 text-[11px] font-semibold',
                  active
                    ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
                )}
                data-testid={`shared-processing-tab-${tab.key}`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        <div
          className="mt-4 space-y-4 rounded-lg border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-section/40"
          data-testid="shared-processing-editor"
          data-shared-edit-mode="true"
          role="tabpanel"
        >
          {children}
        </div>
      </article>
    </section>
  )
}

export function summarizeSharedProtection(dataProtection: WizardDataProtectionState): string {
  const intentCount = dataProtection.intents.filter((i) => i.detectedField.trim()).length
  if (intentCount > 0) return `${intentCount} protection rule${intentCount === 1 ? '' : 's'}`
  return 'Default schema drift policy'
}

/** @deprecated Use summarizeSharedProtection */
export const summarizeGlobalProtection = summarizeSharedProtection

function SharedPolicySummary({
  dataProtection,
}: {
  dataProtection: WizardDataProtectionState
}) {
  const configuredIntents = dataProtection.intents.filter((i) => i.detectedField.trim())
  return (
    <div className="space-y-3" data-testid="shared-policy-editor">
      <p className="text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
        Per-field delivery behavior is configured in{' '}
        <span className="font-semibold text-slate-800 dark:text-slate-100">Data Protection</span> rules. Routes inherit
        these defaults unless a route policy override is set.
      </p>
      {configuredIntents.length > 0 ? (
        <ul className="space-y-1.5 text-[11px]">
          {configuredIntents.map((intent) => (
            <li
              key={intent.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200/90 bg-white px-2.5 py-1.5 dark:border-gdc-border dark:bg-gdc-card"
            >
              <span className="font-mono text-slate-800 dark:text-slate-100">{intent.detectedField}</span>
              <span className="font-semibold text-slate-600 dark:text-gdc-muted">{intent.deliveryBehavior}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
          No protection rules yet — add fields in the Data Protection tab to define delivery behavior.
        </p>
      )}
    </div>
  )
}

export { SharedPolicySummary }
