import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchDestinationsList, type DestinationListItem } from '../../../api/gdcDestinations'
import type { FinalEventDraftPreviewResponse } from '../../../api/gdcRuntimePreview'
import {
  WizardSharedProcessingSection,
  type SharedProcessingTab,
} from '../route-processing/wizard-global-processing-section'
import { WizardRouteProcessingDetailPanel } from '../route-processing/wizard-route-processing-detail-panel'
import { WizardRouteProcessingList } from '../route-processing/wizard-route-processing-list'
import { ROUTE_PROCESSING_COPY } from '../route-processing/route-processing-labels'
import { StepDataProtection } from './step-data-protection'
import { StepMappingCombined } from './step-mapping-combined'
import type { AdvancedTransformRuleDraft } from '../../../types/advancedTransform'
import type { WizardEnrichmentRule } from './enrichment-rules-model'
import { WizardDataProtectionDrawer } from './wizard-data-protection-drawer'
import { WizardMappingOutputAside } from './wizard-mapping-output-aside'
import { ProcessingPreviewDock } from '../../preview/processing-preview-dock'
import { computeRouteDeployReadiness } from './wizard-deploy-readiness'
import { wizardTransformSampleReady } from './wizard-transform-sample'
import type {
  WizardDataProtectionState,
  WizardDestinationsState,
  WizardMappingRow,
  WizardRouteDraft,
  WizardState,
} from './wizard-state'
import { buildRouteTransformOverrideFromGlobal } from './wizard-state'

export type StepRouteProcessingProps = {
  state: WizardState
  onChangeMapping: (rows: WizardMappingRow[]) => void
  onChangeMappingMode: (mode: WizardState['mappingMode']) => void
  onChangeFullEventJsonata: (expression: string) => void
  onChangeFullEventRegexConfigJson: (json: string) => void
  onChangeTransformRules?: (rules: AdvancedTransformRuleDraft[]) => void
  onChangeEnrichment: (rules: WizardEnrichmentRule[]) => void
  onEnableEnrichment?: () => void
  onChangeUnmappedFieldsPolicy?: (policy: WizardState['unmappedFieldsPolicy']) => void
  onChangeDataProtection: (patch: Partial<WizardDataProtectionState>) => void
  onChangeDestinations: (patch: Partial<WizardDestinationsState>) => void
  dataProtectionDrawerOpen?: boolean
  onDataProtectionDrawerOpenChange?: (open: boolean) => void
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
    enrichmentEnabled: override.enrichmentEnabled ?? global.enrichmentEnabled,
    enrichmentOverridePolicy:
      override.enrichmentOverridePolicy ?? global.enrichmentOverridePolicy,
    enrichmentPassthrough:
      override.enrichmentAdvancedPassthrough ?? global.enrichmentPassthrough,
    mappingRawPayloadMode: override.rawPayloadMode ?? global.mappingRawPayloadMode,
    unmappedFieldsPolicy: override.unmappedFieldsPolicy,
  }
}

export function StepRouteProcessing({
  state,
  onChangeMapping,
  onChangeMappingMode,
  onChangeFullEventJsonata,
  onChangeFullEventRegexConfigJson,
  onChangeTransformRules = () => undefined,
  onChangeEnrichment,
  onEnableEnrichment,
  onChangeUnmappedFieldsPolicy,
  onChangeDataProtection,
  onChangeDestinations,
  dataProtectionDrawerOpen,
  onDataProtectionDrawerOpenChange,
}: StepRouteProcessingProps) {
  const [destinations, setDestinations] = useState<DestinationListItem[]>([])
  const [sharedTab, setSharedTab] = useState<SharedProcessingTab>('transform')
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null)
  const [protectionDrawerOpen, setProtectionDrawerOpen] = useState(false)
  const [previewEvidence, setPreviewEvidence] = useState<{
    scope: string
    data: FinalEventDraftPreviewResponse | null
  } | null>(null)
  const onPreviewEvidence = useCallback((scope: string, data: FinalEventDraftPreviewResponse | null) => {
    setPreviewEvidence((previous) => (
      previous?.scope === scope && previous.data === data ? previous : { scope, data }
    ))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows = await fetchDestinationsList()
      if (cancelled) return
      // Failure != empty catalog: keep prior rows (initially []) and avoid false "missing destination" labels.
      if (rows === null) return
      setDestinations(rows)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const destById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])
  const routeDrafts = state.destinations.routeDrafts

  useEffect(() => {
    if (routeDrafts.length === 0) {
      setSelectedRouteKey(null)
      return
    }
    setSelectedRouteKey((prev) => {
      if (prev != null && routeDrafts.some((d) => d.key === prev)) return prev
      return routeDrafts[0]?.key ?? null
    })
  }, [routeDrafts])

  const selectedDraft = routeDrafts.find((d) => d.key === selectedRouteKey) ?? null
  const sampleReady = wizardTransformSampleReady(state)
  // Never show an earlier selected Route's preview for a newly selected Route.
  const activePreview = sampleReady && selectedDraft && previewEvidence?.scope === selectedDraft.key
    ? previewEvidence.data
    : null
  const mappedPreview = activePreview?.mapped_events?.[0] ?? null
  const finalPreview = activePreview?.final_events?.[0] ?? null
  const sampleBeforeMapping = state.apiTest.extractedEvents[0] ?? null
  const drawerOpen = dataProtectionDrawerOpen ?? protectionDrawerOpen
  const setDrawerOpen = onDataProtectionDrawerOpenChange ?? setProtectionDrawerOpen

  const routeDeployReadiness = useMemo(
    () =>
      computeRouteDeployReadiness(
        state,
        destinations.map((d) => ({ id: d.id, name: d.name })),
      ),
    [destinations, state],
  )

  const selectedRouteDeploy = selectedDraft
    ? routeDeployReadiness.routes.find((r) => r.routeKey === selectedDraft.key)
    : undefined

  const outputState = useMemo(() => {
    if (selectedDraft && !selectedDraft.inherit.transform) {
      return buildRouteScopedState(state, selectedDraft)
    }
    return state
  }, [selectedDraft, state])

  const patchRouteUnmappedPolicy = (policy: WizardState['unmappedFieldsPolicy']) => {
    if (!selectedDraft) {
      onChangeUnmappedFieldsPolicy?.(policy)
      return
    }
    if (selectedDraft.inherit.transform) {
      onChangeUnmappedFieldsPolicy?.(policy)
      return
    }
    const current = selectedDraft.overrides?.transform ?? buildRouteTransformOverrideFromGlobal(state)
    onChangeDestinations({
      routeDrafts: state.destinations.routeDrafts.map((draft) =>
        draft.key === selectedDraft.key
          ? {
              ...draft,
              overrides: {
                ...draft.overrides,
                transform: { ...current, unmappedFieldsPolicy: policy },
              },
            }
          : draft,
      ),
    })
  }

  return (
    <div className="space-y-5" data-testid="wizard-step-route-processing">
      <header className="space-y-1">
        <h3 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">Route Processing</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted" data-testid="route-processing-simple-guidance">
          <strong className="font-semibold text-slate-800 dark:text-slate-200">Start with one set of rules.</strong>{' '}
          Shared Processing applies to every destination unless you change it.
          To treat one destination differently, select its Route below and turn off Inherit only for the setting you want to customize.
        </p>
      </header>

      <ProcessingPreviewDock title="Route Processing Preview" stages={[
        { id: 'input', label: 'Input', truth: 'Preview', status: state.apiTest.analysis?.sampleEvent ? 'Sample loaded' : 'No sample loaded', before: state.apiTest.analysis?.sampleEvent ?? null, after: state.apiTest.analysis?.sampleEvent ?? null },
        { id: 'mapping', label: 'Mapping', truth: 'Preview', status: mappedPreview ? 'No-send API preview' : 'Output not verified', before: sampleBeforeMapping, after: mappedPreview, message: 'Preview of the selected Route draft using the existing Mapping API; not saved or delivered.' },
        { id: 'transform', label: 'Enrichment / Transform', truth: 'Preview', status: finalPreview ? 'No-send API preview' : 'Output not verified', before: mappedPreview, after: finalPreview, message: 'Preview of mapping and enrichment only; draft processing is not saved or deployed.' },
        { id: 'policy', label: 'Protection / Policy', truth: 'Preview', status: selectedRouteDeploy?.statusLabel ?? 'Not evaluated', before: finalPreview, after: null, message: 'Mapping/enrichment preview is not Route Protection or Policy proof. Check the effective Route preview before deploy.' },
        { id: 'destination', label: 'Destination Payload', truth: 'Preview', status: selectedDraft ? (destById.get(selectedDraft.destinationId)?.name ?? `Destination #${selectedDraft.destinationId}`) : 'Select a Route', before: finalPreview, after: null, message: 'Mapped draft is not formatted destination payload or verified delivery. Use Route delivery preview and runtime evidence.' },
      ]} />

      <WizardSharedProcessingSection
        state={state}
        activeTab={sharedTab}
        onTabChange={setSharedTab}
        routeCount={routeDrafts.length}
      >
        {sharedTab === 'transform' ? (
          <div className="space-y-4" data-testid="route-processing-shared-transform">
            <StepMappingCombined
              state={state}
              onChangeMapping={onChangeMapping}
              onChangeMappingMode={onChangeMappingMode}
              onChangeFullEventJsonata={onChangeFullEventJsonata}
              onChangeFullEventRegexConfigJson={onChangeFullEventRegexConfigJson}
              onChangeTransformRules={onChangeTransformRules}
              onChangeEnrichment={onChangeEnrichment}
              onEnableEnrichment={onEnableEnrichment}
              onChangeUnmappedFieldsPolicy={onChangeUnmappedFieldsPolicy}
              onChangeDataProtection={onChangeDataProtection}
              dataProtectionDrawerOpen={drawerOpen}
              onDataProtectionDrawerOpenChange={setDrawerOpen}
            />
          </div>
        ) : null}

        {sharedTab === 'data_protection' ? (
          <StepDataProtection state={state} onChange={onChangeDataProtection} section="full" />
        ) : null}
      </WizardSharedProcessingSection>

      <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.55fr)]" data-testid="route-processing-split-layout">
        <WizardRouteProcessingList
          routeDrafts={routeDrafts}
          destinations={destinations}
          dataProtection={state.dataProtection}
          selectedKey={selectedRouteKey}
          onSelect={setSelectedRouteKey}
        />

        <div className="min-w-0 space-y-0" data-testid="route-processing-workspace">
          {selectedDraft ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
              <WizardRouteProcessingDetailPanel
                state={state}
                draft={selectedDraft}
                destination={destById.get(selectedDraft.destinationId)}
                onChangeMapping={onChangeMapping}
                onChangeMappingMode={onChangeMappingMode}
                onChangeFullEventJsonata={onChangeFullEventJsonata}
                onChangeFullEventRegexConfigJson={onChangeFullEventRegexConfigJson}
                onChangeEnrichment={onChangeEnrichment}
                onChangeUnmappedFieldsPolicy={onChangeUnmappedFieldsPolicy}
                onChangeDataProtection={onChangeDataProtection}
                onChangeDestinations={onChangeDestinations}
                dataProtectionDrawerOpen={drawerOpen}
                onDataProtectionDrawerOpenChange={setDrawerOpen}
                showOutputAside={false}
                deployStatus={selectedRouteDeploy?.status}
                deployStatusLabel={selectedRouteDeploy?.statusLabel}
              />

              {sampleReady ? (
                <WizardMappingOutputAside
                  state={outputState}
                  previewScope={selectedDraft.key}
                  onPreviewEvidence={onPreviewEvidence}
                  onChangeUnmappedFieldsPolicy={patchRouteUnmappedPolicy}
                />
              ) : (
                <aside
                  className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-slate-200/90 p-4 text-center dark:border-gdc-border"
                  data-testid="route-processing-output-workspace"
                >
                  <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
                    Complete Sample &amp; Record Selection to preview mapped output.
                  </p>
                </aside>
              )}
            </div>
          ) : (
            <section
              className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-slate-200/90 p-6 text-center dark:border-gdc-border"
              data-testid="route-processing-detail-empty"
            >
              <p className="text-[12px] text-slate-500 dark:text-gdc-muted">{ROUTE_PROCESSING_COPY.selectRouteConfigure}</p>
            </section>
          )}
        </div>
      </div>

      <WizardDataProtectionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        state={state}
        onChange={onChangeDataProtection}
      />
    </div>
  )
}
