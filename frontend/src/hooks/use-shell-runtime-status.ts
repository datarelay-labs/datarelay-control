import { useEffect, useState } from 'react'
import { clearOperationalSnapshotCache, getOperationalSnapshot, type OperationalSnapshotResponse } from '../api/operationalSnapshot'
import { GDC_HEADER_REFRESH_EVENT } from '../components/layout/header-refresh-event'
import { presentShellRuntimeStatus } from '../components/layout/shell-runtime-status'
import { useDocumentVisible } from './use-document-visible'
import { isRuntimeFixtureModeActive } from '../lib/runtime-operational-fixture-mode'

type RuntimeRead = {
  snapshot: OperationalSnapshotResponse | null
  fixture: boolean
  loading: boolean
}

/** One shared cached snapshot read for the shell, not a request per Stream/Route node. */
export function useShellRuntimeStatus(enabled: boolean) {
  const visible = useDocumentVisible()
  const [read, setRead] = useState<RuntimeRead>({ snapshot: null, fixture: false, loading: enabled })
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled || !visible) return
    let alive = true
    let sequence = 0
    const refresh = async (force = false) => {
      const call = ++sequence
      setNowMs(Date.now())
      if (force) clearOperationalSnapshotCache()
      try {
        const [fixture, snapshot] = await Promise.all([
          isRuntimeFixtureModeActive(),
          getOperationalSnapshot(),
        ])
        if (!alive || call !== sequence) return
        setRead({ fixture: fixture && snapshot != null, snapshot, loading: false })
      } catch {
        if (!alive || call !== sequence) return
        setRead({ fixture: false, snapshot: null, loading: false })
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), 45_000)
    const onHeaderRefresh = () => void refresh(true)
    window.addEventListener(GDC_HEADER_REFRESH_EVENT, onHeaderRefresh)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener(GDC_HEADER_REFRESH_EVENT, onHeaderRefresh)
    }
  }, [enabled, visible])

  return presentShellRuntimeStatus(read.snapshot, {
    fixture: read.fixture,
    loading: read.loading,
    nowMs,
  })
}
