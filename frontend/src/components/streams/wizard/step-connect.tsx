import { useCallback, useState } from 'react'
import type { FieldImportance } from '../../../lib/field-importance'
import { cn } from '../../../lib/utils'
import { resolveSourceTypePresentation } from '../../../utils/sourceTypePresentation'
import { FieldImportanceBadge } from './field-importance-badge'
import { StepConfig } from './step-config'
import { StepSource } from './step-source'
import type { WizardState } from './wizard-state'

export type ConnectTabKey = 'connector' | 'request' | 'advanced'

export type StepConnectProps = {
  state: WizardState
  activeTab?: ConnectTabKey
  onTabChange?: (tab: ConnectTabKey) => void
  connectorReadonly?: boolean
  onConnectorChange: (patch: Partial<WizardState['connector']>) => void
  onStreamChange: (patch: Partial<WizardState['stream']>) => void
}

const TAB_DEFS: ReadonlyArray<{
  key: ConnectTabKey
  label: string
  importance: Extract<FieldImportance, 'required' | 'optional'>
}> = [
  { key: 'connector', label: 'Connector', importance: 'required' },
  { key: 'request', label: 'Request Configuration', importance: 'required' },
  { key: 'advanced', label: 'Advanced Settings', importance: 'optional' },
]

export function StepConnect({
  state,
  activeTab: controlledTab,
  onTabChange,
  connectorReadonly = false,
  onConnectorChange,
  onStreamChange,
}: StepConnectProps) {
  const [internalTab, setInternalTab] = useState<ConnectTabKey>('connector')
  const activeTab = controlledTab ?? internalTab
  const sourcePres = resolveSourceTypePresentation(state.connector.sourceType)

  const setTab = useCallback(
    (next: ConnectTabKey) => {
      if (onTabChange) onTabChange(next)
      else setInternalTab(next)
    },
    [onTabChange],
  )

  const requestLabel =
    sourcePres.wizard.streamStepTitle === 'HTTP Request' ? 'Request Configuration' : sourcePres.wizard.streamStepTitle

  const primaryTabs = TAB_DEFS.filter((tab) => tab.key !== 'advanced').map((tab) =>
    tab.key === 'request' ? { ...tab, label: requestLabel } : tab,
  )
  const advancedTab = TAB_DEFS.find((tab) => tab.key === 'advanced')!

  return (
    <div className="space-y-5" data-testid="wizard-step-connect">
      <header className="space-y-1">
        <h3 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">Connect</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
          Select a connector and define the request. Authentication is inherited from the saved connector when one is
          selected. Advanced settings stay optional until you need them.
        </p>
      </header>

      <nav
        className="flex flex-wrap items-center gap-2"
        aria-label="Connect sections"
        data-testid="wizard-connect-tabs"
      >
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200/80 bg-slate-50/80 p-1 dark:border-gdc-border dark:bg-gdc-card">
          {primaryTabs.map((tab) => {
            const active = tab.key === activeTab
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`wizard-connect-tab-${tab.key}`}
                onClick={() => setTab(tab.key)}
                className={cn(
                  'rounded-md px-3 py-2 text-sm font-semibold transition-colors',
                  active
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-gdc-section dark:text-slate-50'
                    : 'text-slate-600 hover:bg-white/70 hover:text-slate-900 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover dark:hover:text-slate-100',
                )}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span>{tab.label}</span>
                  <FieldImportanceBadge
                    importance={tab.importance}
                    title="Required to continue"
                    className="text-[10px] font-semibold normal-case tracking-normal"
                  />
                </span>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'advanced'}
          data-testid="wizard-connect-tab-advanced"
          onClick={() => setTab('advanced')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
            activeTab === 'advanced'
              ? 'border-slate-300 bg-white text-slate-800 shadow-sm dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100'
              : 'border-dashed border-slate-300/90 bg-transparent text-slate-500 hover:border-slate-400 hover:text-slate-700 dark:border-gdc-border dark:text-gdc-muted dark:hover:text-slate-200',
          )}
        >
          <span>{advancedTab.label}</span>
          <FieldImportanceBadge
            importance={advancedTab.importance}
            title="Optional configuration"
            className="text-[10px] font-semibold normal-case tracking-normal"
          />
        </button>
      </nav>

      <div role="tabpanel">
        {activeTab === 'connector' ? (
          <StepSource
            state={state}
            section="connector"
            connectorReadonly={connectorReadonly}
            onChange={onConnectorChange}
            onOpenRequestConfiguration={() => setTab('request')}
            requestConfigurationLabel={requestLabel}
          />
        ) : null}
        {activeTab === 'request' ? <StepConfig state={state} section="request" onChange={onStreamChange} /> : null}
        {activeTab === 'advanced' ? (
          <div
            className="rounded-xl border border-dashed border-slate-300/90 bg-slate-50/40 p-4 dark:border-gdc-border dark:bg-gdc-section/40"
            data-testid="wizard-connect-advanced-panel"
          >
            <p className="mb-3 text-sm text-slate-600 dark:text-gdc-muted">
              Optional pagination, retry, and advanced request controls. Most streams can continue without changing
              these.
            </p>
            <StepConfig state={state} section="advanced" onChange={onStreamChange} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
