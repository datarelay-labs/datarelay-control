import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { clearOperationalSnapshotCache } from '../../api/operationalSnapshot'
import {
  DEFAULT_RUNTIME_FIXTURE_FILE,
  disableRuntimeFixtureMode,
  enableRuntimeFixtureMode,
  getRuntimeFixtureFileName,
  hasRuntimeFixtureUserOptIn,
  isRuntimeFixtureModeActive,
  isRuntimeFixturePolicyGranted,
  loadOperationalSnapshotFixture,
  summarizeRuntimeFixture,
  syncRuntimeFixtureModeFromSearchParams,
  type RuntimeFixtureSummary,
} from '../../lib/runtime-operational-fixture-mode'

export function RuntimeFixtureModeBanner({ surface }: { surface: 'runtime' | 'routes' | 'dashboard' | 'streams' }) {
  const [searchParams] = useSearchParams()
  const [policyGranted, setPolicyGranted] = useState(false)
  const [active, setActive] = useState(false)
  const [summary, setSummary] = useState<RuntimeFixtureSummary | null>(null)
  const [fileInput, setFileInput] = useState(DEFAULT_RUNTIME_FIXTURE_FILE)

  const refreshState = useCallback(async () => {
    const granted = await isRuntimeFixturePolicyGranted()
    setPolicyGranted(granted)
    if (!granted) {
      setActive(false)
      setSummary(null)
      return
    }
    const isActive = await isRuntimeFixtureModeActive()
    setActive(isActive)
    setFileInput(getRuntimeFixtureFileName())
    if (!isActive) {
      setSummary(null)
      return
    }
    const snap = await loadOperationalSnapshotFixture()
    if (snap) {
      setSummary(summarizeRuntimeFixture(snap, getRuntimeFixtureFileName()))
    } else {
      setSummary(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await syncRuntimeFixtureModeFromSearchParams(searchParams)
      if (cancelled) return
      await refreshState()
    })()
    return () => {
      cancelled = true
    }
  }, [searchParams, refreshState])

  if (!policyGranted) return null

  const applyFixtureMode = async (next: boolean) => {
    if (next) {
      enableRuntimeFixtureMode(fileInput.trim() || DEFAULT_RUNTIME_FIXTURE_FILE)
    } else {
      disableRuntimeFixtureMode()
    }
    clearOperationalSnapshotCache()
    await refreshState()
    window.location.reload()
  }

  if (active && summary) {
    return (
      <div
        data-testid="runtime-fixture-mode-active-banner"
        role="alert"
        className="rounded-lg border border-amber-500/80 bg-amber-100/95 px-3 py-2 text-[12px] font-medium text-amber-950 dark:border-amber-500/50 dark:bg-amber-950/40 dark:text-amber-50"
      >
        <p className="font-semibold uppercase tracking-wide">
          DEV FIXTURE MODE ACTIVE — using simulated operational snapshot
        </p>
        <p className="mt-1 font-mono text-[11px] font-normal" data-testid="runtime-fixture-mode-summary">
          {summary.fileName} · {summary.streamCount} streams · {summary.routeCount} routes
        </p>
        <p className="mt-1 text-[11px] font-normal opacity-90">
          {surface === 'runtime'
            ? 'Runtime Overview'
            : surface === 'routes'
              ? 'Routes'
              : surface === 'dashboard'
                ? 'Dashboard'
                : 'Streams'}{' '}
          is not calling <code className="font-mono">/api/v1/runtime/operational-snapshot</code>.
        </p>
        <button
          type="button"
          data-testid="runtime-fixture-mode-disable"
          className="mt-2 h-8 rounded-md border border-amber-700/40 bg-white px-2.5 text-[11px] font-semibold hover:bg-amber-50 dark:bg-gdc-card"
          onClick={() => void applyFixtureMode(false)}
        >
          Disable fixture mode
        </button>
      </div>
    )
  }

  if (!hasRuntimeFixtureUserOptIn()) {
    return (
      <div
        data-testid="runtime-fixture-mode-admin-panel"
        className="rounded-lg border border-dashed border-amber-400/50 bg-amber-50/50 px-3 py-2 text-[12px] text-amber-950 dark:border-amber-600/30 dark:bg-amber-950/20 dark:text-amber-100"
      >
        <p className="font-semibold">Runtime fixture mode (admin / dev-validation)</p>
        <p className="mt-1 text-[11px] opacity-90">
          Load scale fixtures from <code className="font-mono">/dev-fixtures/</code> for virtualization validation.
          Use <code className="font-mono">?runtime_fixture=1</code> or enable below.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`fixture-file-${surface}`}>
            Fixture file
          </label>
          <input
            id={`fixture-file-${surface}`}
            value={fileInput}
            onChange={(e) => setFileInput(e.target.value)}
            className="h-8 min-w-[220px] rounded border border-amber-300/80 bg-white px-2 font-mono text-[11px] dark:border-amber-700 dark:bg-gdc-card"
            placeholder={DEFAULT_RUNTIME_FIXTURE_FILE}
          />
          <button
            type="button"
            data-testid="runtime-fixture-mode-enable"
            className="h-8 rounded-md border border-amber-600/50 bg-amber-700 px-2.5 text-[11px] font-semibold text-white hover:bg-amber-800"
            onClick={() => void applyFixtureMode(true)}
          >
            Enable fixture mode
          </button>
        </div>
      </div>
    )
  }

  return null
}
