import { Clock } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAdminDisplaySettings } from '../../api/gdcAdmin'
import { useDisplayTimezone } from '../../contexts/display-timezone-context'
import { listIanaTimezones, timezoneSelectOptions } from '../../lib/iana-timezones'
import { cn } from '../../lib/utils'
import { gdcUi } from '../../lib/gdc-ui-tokens'

const cardShell = gdcUi.cardShell
const IANA_TIMEZONES = listIanaTimezones()

type Props = {
  backendRole: string | null
  readOnly: boolean
  busy: boolean
  setBusy: (v: boolean) => void
  setPageMsg: (v: string | null) => void
  setPageErr: (v: string | null) => void
}

export function AdminDisplayTimezoneSettings({
  backendRole,
  readOnly,
  busy,
  setBusy,
  setPageMsg,
  setPageErr,
}: Props) {
  const {
    timezone: resolvedTimezone,
    userTimezone,
    platformDefaultTimezone,
    setUserTimezone,
    setPlatformDefaultTimezone,
    formatTimestamp,
  } = useDisplayTimezone()
  const [platformDraft, setPlatformDraft] = useState(platformDefaultTimezone)
  const [userDraft, setUserDraft] = useState(userTimezone ?? '')
  const [userFilter, setUserFilter] = useState('')
  const [platformFilter, setPlatformFilter] = useState('')
  const isAdmin = backendRole === 'ADMINISTRATOR'

  useEffect(() => {
    setPlatformDraft(platformDefaultTimezone)
  }, [platformDefaultTimezone])

  useEffect(() => {
    setUserDraft(userTimezone ?? '')
  }, [userTimezone])

  useEffect(() => {
    if (!isAdmin) return
    void (async () => {
      try {
        const row = await getAdminDisplaySettings()
        setPlatformDraft(row.default_timezone || 'UTC')
      } catch {
        /* whoami cache is enough for display */
      }
    })()
  }, [isAdmin])

  const userOptions = useMemo(
    () => timezoneSelectOptions(userDraft, userFilter, IANA_TIMEZONES),
    [userDraft, userFilter],
  )
  const platformOptions = useMemo(
    () => timezoneSelectOptions(platformDraft, platformFilter, IANA_TIMEZONES),
    [platformDraft, platformFilter],
  )

  const onSavePlatform = useCallback(async () => {
    if (!isAdmin || readOnly) return
    setBusy(true)
    setPageErr(null)
    try {
      await setPlatformDefaultTimezone(platformDraft.trim() || 'UTC')
      setPageMsg('Platform default timezone saved.')
    } catch (err) {
      setPageErr(err instanceof Error ? err.message : 'Failed to save platform timezone.')
    } finally {
      setBusy(false)
    }
  }, [isAdmin, platformDraft, readOnly, setBusy, setPageErr, setPageMsg, setPlatformDefaultTimezone])

  const onSaveUser = useCallback(async () => {
    if (readOnly) return
    setBusy(true)
    setPageErr(null)
    try {
      const next = userDraft.trim() || null
      await setUserTimezone(next)
      setPageMsg(next ? 'Your display timezone was updated.' : 'Your display timezone preference was cleared.')
    } catch (err) {
      setPageErr(err instanceof Error ? err.message : 'Failed to save your timezone.')
    } finally {
      setBusy(false)
    }
  }, [readOnly, setBusy, setPageErr, setPageMsg, setUserTimezone, userDraft])

  const sampleUtc = '2026-06-29T07:10:00Z'
  const selectClassName =
    'mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px] dark:border-gdc-border dark:bg-gdc-section'
  const filterClassName =
    'mt-3 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] dark:border-gdc-border dark:bg-gdc-section'

  return (
    <section className={cn(cardShell, 'p-4 md:p-6')} aria-labelledby="admin-display-timezone-heading">
      <div className="mb-4 flex gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/[0.07] text-sky-700 dark:border-sky-400/35 dark:bg-sky-500/15 dark:text-sky-100">
          <Clock className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h3 id="admin-display-timezone-heading" className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">
            Display timezone
          </h3>
          <p className="mt-0.5 max-w-2xl text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
            Runtime data and APIs stay in UTC. Timestamps in the UI are converted using your account timezone, then the
            platform default, then your browser timezone.
          </p>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-gdc-muted">
            Active resolution: <span className="font-medium text-slate-800 dark:text-slate-200">{resolvedTimezone}</span>
            {' · '}
            Example: {formatTimestamp(sampleUtc)}
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200/80 p-4 dark:border-gdc-border">
          <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Your timezone</h4>
          <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted">Optional override for your account.</p>
          <label className="block text-[11px] font-medium text-slate-700 dark:text-gdc-mutedStrong">
            Filter timezones
            <input
              type="search"
              className={filterClassName}
              value={userFilter}
              disabled={readOnly || busy}
              placeholder="e.g. Los_Angeles or Berlin"
              aria-controls="user-display-timezone"
              onChange={(e) => setUserFilter(e.target.value)}
            />
          </label>
          <label className="mt-3 block text-[11px] font-medium text-slate-700 dark:text-gdc-mutedStrong">
            IANA timezone
            <select
              id="user-display-timezone"
              className={selectClassName}
              value={userDraft || ''}
              disabled={readOnly || busy}
              onChange={(e) => setUserDraft(e.target.value)}
            >
              <option value="">(use platform / browser)</option>
              {userOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:text-slate-100 dark:hover:bg-gdc-section"
            disabled={readOnly || busy}
            onClick={() => void onSaveUser()}
          >
            Save my timezone
          </button>
        </div>

        <div className="rounded-lg border border-slate-200/80 p-4 dark:border-gdc-border">
          <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Platform default timezone</h4>
          <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted">
            Used when a user has no personal timezone. Administrator only.
          </p>
          <label className="block text-[11px] font-medium text-slate-700 dark:text-gdc-mutedStrong">
            Filter timezones
            <input
              type="search"
              className={filterClassName}
              value={platformFilter}
              disabled={!isAdmin || readOnly || busy}
              placeholder="e.g. Los_Angeles or Berlin"
              aria-controls="platform-display-timezone"
              onChange={(e) => setPlatformFilter(e.target.value)}
            />
          </label>
          <label className="mt-3 block text-[11px] font-medium text-slate-700 dark:text-gdc-mutedStrong">
            IANA timezone
            <select
              id="platform-display-timezone"
              className={selectClassName}
              value={platformDraft}
              disabled={!isAdmin || readOnly || busy}
              onChange={(e) => setPlatformDraft(e.target.value)}
            >
              {platformOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="mt-3 rounded-lg border border-violet-500/30 bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50 dark:border-violet-500/40"
            disabled={!isAdmin || readOnly || busy}
            onClick={() => void onSavePlatform()}
          >
            Save platform default
          </button>
        </div>
      </div>
    </section>
  )
}
