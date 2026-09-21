import { useCallback, useState } from 'react'
import { cn } from '../../../lib/utils'
import { RecordSelectionWorkspace, scrollRecordSelectionWorkspaceToTop } from './record-selection-workspace'
import { StepApiTest } from './step-api-test'
import type { WizardConfigState, WizardState } from './wizard-state'
import type { OperationalSampleId } from './wizard-operational-samples'

export type SampleTabKey = 'run_test' | 'record_selection'

export type StepSampleProps = {
  state: WizardState
  activeTab?: SampleTabKey
  onTabChange?: (tab: SampleTabKey) => void
  onApiTestChange: (next: WizardState['apiTest']) => void
  onStreamPatch: (patch: Partial<WizardConfigState>) => void
  onSetEventArrayPath: (path: string) => void
  onSetEventRootPath: (path: string) => void
  onSetCheckpoint: (patch: Partial<Pick<WizardConfigState, 'checkpointFieldType' | 'checkpointSourcePath'>>) => void
  onLoadOperationalSample?: (id: OperationalSampleId) => void
  activeOperationalSampleId?: OperationalSampleId | null
}

const TAB_DEFS: ReadonlyArray<{ key: SampleTabKey; label: string }> = [
  { key: 'run_test', label: 'Run Test' },
  { key: 'record_selection', label: 'Record Selection' },
]

export function StepSample({
  state,
  activeTab: controlledTab,
  onTabChange,
  onApiTestChange,
  onStreamPatch,
  onSetEventArrayPath,
  onSetEventRootPath,
  onSetCheckpoint,
  onLoadOperationalSample,
  activeOperationalSampleId,
}: StepSampleProps) {
  const [internalTab, setInternalTab] = useState<SampleTabKey>('run_test')
  const activeTab = controlledTab ?? internalTab

  const setTab = useCallback(
    (next: SampleTabKey) => {
      if (onTabChange) onTabChange(next)
      else setInternalTab(next)
    },
    [onTabChange],
  )

  const advanceToRecordSelection = useCallback(() => {
    setTab('record_selection')
    scrollRecordSelectionWorkspaceToTop('smooth')
  }, [setTab])

  const handleTabChange = useCallback(
    (next: SampleTabKey) => {
      setTab(next)
      if (next === 'record_selection') scrollRecordSelectionWorkspaceToTop('smooth')
    },
    [setTab],
  )

  return (
    <div className="space-y-5" data-testid="wizard-step-sample">
      <header className="space-y-1">
        <h3 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          Sample &amp; Record Selection
        </h3>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
          Fetch a sample first, then confirm the record path, event root, and sync position before choosing
          destinations.
        </p>
      </header>

      <nav
        className="flex flex-wrap gap-1 rounded-lg border border-slate-200/80 bg-slate-50/80 p-1 dark:border-gdc-border dark:bg-gdc-card"
        aria-label="Sample sections"
        data-testid="wizard-sample-tabs"
      >
        {TAB_DEFS.map((tab) => {
          const active = tab.key === activeTab
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`wizard-sample-tab-${tab.key}`}
              onClick={() => handleTabChange(tab.key)}
              className={cn(
                'rounded-md px-3 py-2 text-sm font-semibold transition-colors',
                active
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-gdc-section dark:text-slate-50'
                  : 'text-slate-600 hover:bg-white/70 hover:text-slate-900 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover dark:hover:text-slate-100',
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </nav>

      <div role="tabpanel">
        {activeTab === 'run_test' ? (
          <StepApiTest
            state={state}
            onChange={onApiTestChange}
            onStreamPatch={onStreamPatch}
            onLoadOperationalSample={onLoadOperationalSample}
            activeOperationalSampleId={activeOperationalSampleId}
            onAdvanceToRecordSelection={advanceToRecordSelection}
          />
        ) : null}
        {activeTab === 'record_selection' ? (
          <RecordSelectionWorkspace
            state={state}
            onSetEventArrayPath={onSetEventArrayPath}
            onSetEventRootPath={onSetEventRootPath}
            onSetCheckpoint={onSetCheckpoint}
            onStreamPatch={onStreamPatch}
            onLoadOperationalSample={onLoadOperationalSample}
            activeOperationalSampleId={activeOperationalSampleId}
          />
        ) : null}
      </div>
    </div>
  )
}
