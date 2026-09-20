import { ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import type { DestinationListItem } from '../../../api/gdcDestinations'
import { StepDataProtection } from '../wizard/step-data-protection'
import { StepMappingCombined } from '../wizard/step-mapping-combined'
import type { WizardEnrichmentRule } from '../wizard/enrichment-rules-model'
import { RouteClassificationOverridesSection } from '../wizard/route-classification-overrides-section'
import { failurePolicyBehaviorLabel, formatWizardRateLimitDraft } from '../wizard/wizard-delivery-helpers'
import {
  buildRouteProtectionOverrideFromGlobal,
  buildRouteTransformOverrideFromGlobal,
  computeWizardRouteProcessingStatuses,
  type WizardDataProtectionState,
  type WizardDestinationsState,
  type WizardMappingRow,
  type WizardRouteDraft,
  type WizardState,
} from '../wizard/wizard-state'
import { ROUTE_PROCESSING_COPY, routeDraftUsesSharedProcessing } from './route-processing-labels'
import { RouteProcessingModeSelector, type RouteProcessingMode } from './route-processing-mode-selector'
import { RouteProcessingDetailHeader } from './route-processing-detail-header'

const inputCls =
  'h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

type DetailTab = 'transform' | 'data_protection' | 'delivery'

const TABS: ReadonlyArray<{ key: DetailTab; label: string }> = [
  { key: 'transform', label: 'Transform' },
  { key: 'data_protection', label: 'Data Protection' },
  { key: 'delivery', label: 'Delivery' },
]

function patchRouteDraft(
  drafts: WizardRouteDraft[],
  key: string,
  patch: Partial<WizardRouteDraft>,
): WizardRouteDraft[] {
  return drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft))
}

function buildRouteScopedState(global: WizardState, draft: WizardRouteDraft): WizardState {
  const override = draft.overrides?.transform
  if (!override) return global
  return {
    ...global,
    mapping: override.mapping,
    mappingMode: override.mappingMode,
    fullEventJsonataExpression: override.fullEventJsonataExpression,
    fullEventRegexConfigJson: override.fullEventRegexConfigJson,
    transformRules: override.transformRules,
    enrichment: override.enrichment,
    unmappedFieldsPolicy: override.unmappedFieldsPolicy,
  }
}

function buildRouteProtectionState(global: WizardState, draft: WizardRouteDraft): WizardState {
  const override = draft.overrides?.protection
  if (!override) return global
  return {
    ...global,
    dataProtection: {
      ...global.dataProtection,
      intents: override.intents,
      unknownNormalFieldPolicy: override.unknownNormalFieldPolicy,
      unknownSensitiveFieldPolicy: override.unknownSensitiveFieldPolicy,
      routeOverrides: global.dataProtection.routeOverrides.filter((o) => o.routeDraftKey === draft.key),
    },
  }
}

export function WizardRouteProcessingDetailPanel({
  state,
  draft,
  destination,
  onChangeDataProtection,
  onChangeDestinations,
  showOutputAside = true,
  deployStatus,
  deployStatusLabel,
}: {
  state: WizardState
  draft: WizardRouteDraft
  destination: DestinationListItem | undefined
  onChangeMapping: (rows: WizardMappingRow[]) => void
  onChangeMappingMode: (mode: WizardState['mappingMode']) => void
  onChangeFullEventJsonata: (expression: string) => void
  onChangeFullEventRegexConfigJson: (json: string) => void
  onChangeEnrichment: (rules: WizardEnrichmentRule[]) => void
  onChangeUnmappedFieldsPolicy?: (policy: WizardState['unmappedFieldsPolicy']) => void
  onChangeDataProtection: (patch: Partial<WizardDataProtectionState>) => void
  onChangeDestinations: (patch: Partial<WizardDestinationsState>) => void
  dataProtectionDrawerOpen?: boolean
  onDataProtectionDrawerOpenChange?: (open: boolean) => void
  showOutputAside?: boolean
  deployStatus?: 'ready' | 'warning' | 'error'
  deployStatusLabel?: string
}) {
  const [tab, setTab] = useState<DetailTab>('transform')
  const routeLabel = destination?.name?.trim() || `Destination #${draft.destinationId}`
  const destinationMissing = !draft.destinationId || draft.destinationId <= 0 || !destination

  const patchRoute = (patch: Partial<WizardRouteDraft>) => {
    onChangeDestinations({
      routeDrafts: patchRouteDraft(state.destinations.routeDrafts, draft.key, patch),
    })
  }

  const usesShared = routeDraftUsesSharedProcessing(draft)
  const routeMode: RouteProcessingMode = usesShared ? 'shared' : 'override'

  const patchRouteMode = (mode: RouteProcessingMode) => {
    if (mode === 'shared') {
      patchRoute({
        inherit: { transform: true, protection: true, classification: true, policy: true },
      })
      return
    }
    const nextOverrides = { ...draft.overrides }
    if (!nextOverrides.transform) nextOverrides.transform = buildRouteTransformOverrideFromGlobal(state)
    if (!nextOverrides.protection) nextOverrides.protection = buildRouteProtectionOverrideFromGlobal(state.dataProtection)
    if (!nextOverrides.policy) nextOverrides.policy = { deliveryBehavior: 'continue' }
    patchRoute({
      inherit: { transform: false, protection: false, classification: false, policy: false },
      overrides: nextOverrides,
    })
  }

  useEffect(() => {
    if (usesShared && tab !== 'delivery') setTab('delivery')
    if (!usesShared && tab === 'delivery') setTab('transform')
  }, [usesShared]) // eslint-disable-line react-hooks/exhaustive-deps

  const visibleTabs = usesShared ? TABS.filter((item) => item.key === 'delivery') : TABS

  const patchRouteTransform = (patch: Partial<WizardState>) => {
    const current = draft.overrides?.transform ?? buildRouteTransformOverrideFromGlobal(state)
    const next = {
      mapping: patch.mapping ?? current.mapping,
      mappingMode: patch.mappingMode ?? current.mappingMode,
      fullEventJsonataExpression: patch.fullEventJsonataExpression ?? current.fullEventJsonataExpression,
      fullEventRegexConfigJson: patch.fullEventRegexConfigJson ?? current.fullEventRegexConfigJson,
      transformRules: patch.transformRules ?? current.transformRules,
      enrichment: patch.enrichment ?? current.enrichment,
      unmappedFieldsPolicy: patch.unmappedFieldsPolicy ?? current.unmappedFieldsPolicy,
    }
    patchRoute({ overrides: { ...draft.overrides, transform: next } })
  }

  const patchRouteProtection = (patch: Partial<WizardDataProtectionState>) => {
    const current = draft.overrides?.protection ?? buildRouteProtectionOverrideFromGlobal(state.dataProtection)
    patchRoute({
      overrides: {
        ...draft.overrides,
        protection: {
          intents: patch.intents ?? current.intents,
          unknownNormalFieldPolicy: patch.unknownNormalFieldPolicy ?? current.unknownNormalFieldPolicy,
          unknownSensitiveFieldPolicy: patch.unknownSensitiveFieldPolicy ?? current.unknownSensitiveFieldPolicy,
        },
      },
    })
  }

  const routeTransformState = useMemo(() => buildRouteScopedState(state, draft), [draft, state])
  const routeProtectionState = useMemo(() => buildRouteProtectionState(state, draft), [draft, state])
  const processingStatuses = useMemo(
    () => computeWizardRouteProcessingStatuses(draft, state.dataProtection),
    [draft, state.dataProtection],
  )

  const epsVal = typeof draft.rateLimitJson.per_second === 'number' ? String(draft.rateLimitJson.per_second) : ''
  const burstVal = typeof draft.rateLimitJson.burst_size === 'number' ? String(draft.rateLimitJson.burst_size) : ''

  return (
    <section
      className="rounded-lg border border-slate-200/90 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid="route-processing-detail-panel"
    >
      <RouteProcessingDetailHeader
        routeLabel={routeLabel}
        destinationLabel={destination?.name}
        destinationMissing={destinationMissing}
        processingStatuses={processingStatuses}
        deployStatus={deployStatus}
        deployStatusLabel={deployStatusLabel}
      />

      <div className="space-y-3 border-b border-slate-100 px-3 py-3 dark:border-gdc-border">
        <RouteProcessingModeSelector mode={routeMode} onChange={patchRouteMode} />
        {usesShared ? (
          <p className="text-[11px] text-slate-600 dark:text-gdc-muted" data-testid="route-shared-mode-summary">
            {ROUTE_PROCESSING_COPY.routeUsesShared} {ROUTE_PROCESSING_COPY.routeUsesSharedHint}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-100 px-2 pt-2 dark:border-gdc-border" role="tablist">
        {visibleTabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={cn(
              '-mb-px border-b-2 px-2.5 pb-2 text-[11px] font-semibold',
              tab === item.key
                ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
            )}
            data-testid={`route-detail-tab-${item.key}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="space-y-3 p-3">
        {!usesShared && tab === 'transform' ? (
          <div className="space-y-3" data-testid="route-detail-transform">
            <StepMappingCombined
              state={routeTransformState}
              onChangeMapping={(rows) => patchRouteTransform({ mapping: rows })}
              onChangeMappingMode={(mode) => patchRouteTransform({ mappingMode: mode })}
              onChangeFullEventJsonata={(expr) => patchRouteTransform({ fullEventJsonataExpression: expr })}
              onChangeFullEventRegexConfigJson={(json) => patchRouteTransform({ fullEventRegexConfigJson: json })}
              onChangeEnrichment={(rules) => patchRouteTransform({ enrichment: rules })}
              onChangeUnmappedFieldsPolicy={(policy) => patchRouteTransform({ unmappedFieldsPolicy: policy })}
              onChangeDataProtection={() => {}}
              showOutputAside={showOutputAside}
            />
          </div>
        ) : null}

        {!usesShared && tab === 'data_protection' ? (
          <div className="space-y-4" data-testid="route-detail-data-protection">
            <StepDataProtection state={routeProtectionState} onChange={(patch) => patchRouteProtection(patch)} />
            <RouteClassificationOverridesSection
              state={state.dataProtection}
              routeDrafts={[draft]}
              onChange={onChangeDataProtection}
            />
            <section
              className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
              data-testid="route-default-delivery-behavior-section"
            >
              <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Default Delivery Behavior</p>
              <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">
                Route-level default when protection rules do not specify delivery behavior.
              </p>
              <label className="mt-3 grid max-w-xs gap-1 text-[11px]">
                <span className="font-semibold text-slate-700 dark:text-slate-200">Delivery behavior</span>
                <div className="relative">
                  <select
                    value={draft.overrides?.policy?.deliveryBehavior ?? 'continue'}
                    onChange={(e) =>
                      patchRoute({
                        overrides: {
                          ...draft.overrides,
                          policy: {
                            deliveryBehavior: e.target.value as WizardState['dataProtection']['intents'][0]['deliveryBehavior'],
                          },
                        },
                      })
                    }
                    className={cn(inputCls, 'appearance-none pr-8')}
                    data-testid="route-policy-delivery-behavior"
                  >
                    <option value="continue">Continue</option>
                    <option value="quarantine">Quarantine</option>
                    <option value="block">Block</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
                </div>
                <span className="text-[10px] text-slate-500 dark:text-gdc-muted">
                  Block stops the entire event from delivery. Remove (in protection) deletes fields only.
                </span>
              </label>
            </section>
          </div>
        ) : null}

        {tab === 'delivery' ? (
          <div className="space-y-3" data-testid="route-detail-delivery">
            <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
              Delivery settings are always route-specific — no shared inheritance.
            </p>
            <label className="flex items-center gap-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => patchRoute({ enabled: e.target.checked })}
                className="accent-violet-600"
                data-testid={`route-processing-enabled-${draft.key}`}
              />
              Enabled
            </label>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Failure policy</label>
              <div className="relative max-w-md">
                <select
                  value={draft.failurePolicy}
                  onChange={(e) => patchRoute({ failurePolicy: e.target.value as WizardRouteDraft['failurePolicy'] })}
                  className={cn(inputCls, 'appearance-none pr-8')}
                  data-testid={`route-processing-failure-policy-${draft.key}`}
                >
                  <option value="LOG_AND_CONTINUE">LOG_AND_CONTINUE</option>
                  <option value="RETRY_AND_BACKOFF">RETRY_AND_BACKOFF</option>
                  <option value="PAUSE_STREAM_ON_FAILURE">PAUSE_STREAM_ON_FAILURE</option>
                  <option value="DISABLE_ROUTE_ON_FAILURE">DISABLE_ROUTE_ON_FAILURE</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
              </div>
              <p className="text-[10px] text-slate-500">{failurePolicyBehaviorLabel(draft.failurePolicy)}</p>
            </div>
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Rate limit</p>
              <p className="text-[11px] text-slate-600 dark:text-gdc-muted">{formatWizardRateLimitDraft(draft.rateLimitJson)}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-slate-500">EPS (optional)</label>
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    placeholder="Destination default"
                    value={epsVal}
                    onChange={(e) => {
                      const v = e.target.value
                      const next = { ...draft.rateLimitJson }
                      if (v === '') delete next.per_second
                      else next.per_second = Number(v)
                      patchRoute({ rateLimitJson: next })
                    }}
                    data-testid={`route-processing-eps-${draft.key}`}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-slate-500">Burst (optional)</label>
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    placeholder="Destination default"
                    value={burstVal}
                    onChange={(e) => {
                      const v = e.target.value
                      const next = { ...draft.rateLimitJson }
                      if (v === '') delete next.burst_size
                      else next.burst_size = Number(v)
                      patchRoute({ rateLimitJson: next })
                    }}
                    data-testid={`route-processing-burst-${draft.key}`}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
