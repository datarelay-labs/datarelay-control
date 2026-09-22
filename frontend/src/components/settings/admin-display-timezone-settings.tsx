import { Clock } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAdminDisplaySettings } from '../../api/gdcAdmin'
import { useDisplayTimezone } from '../../contexts/display-timezone-context'
import { listIanaTimezones, timezoneSelectOptions } from '../../lib/iana-timezones'
import { cn } from '../../lib/utils'
import { gdcUi } from '../../lib/gdc-ui-tokens'

const IANA_TIMEZONES = listIanaTimezones()

type Props = {
  backendRole: string | null
  readOnly: boolean
  busy: boolean
  setBusy: (v: boolean) => void
  setPageMsg: (v: string | null) => void
  setPageErr: (v: string | null) => void
}

function resolutionSourceLabel(input: {
  userTimezone: string | null
  platformDefaultTimezone: string
  resolvedTimezone: string
}): string {
  if (input.userTimezone && input.userTimezone === input.resolvedTimezone) {
    return 'Your account override'
  }
  if (input.platformDefaultTimezone === input.resolvedTimezone) {
    return 'Platform default'
  }
  return 'Browser timezone'
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
  const sectionStepLabel = 'text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted'
  const fieldLabel = 'text-sm font-medium text-slate-700 dark:text-slate-200'
  const fieldHint = 'mt-1 text-xs leading-relaxed text-slate-500 dark:text-gdc-muted'
  const selectClassName = cn('mt-1.5 w-full', gdcUi.input)
  const filterClassName = cn('mt-1.5 w-full', gdcUi.input)
  const resolutionSource = resolutionSourceLabel({
    userTimezone,
    platformDefaultTimezone,
    resolvedTimezone,
  })

  return (
    <section
      className={cn(gdcUi.cardShell, 'overflow-hidden')}
      aria-labelledby="admin-display-timezone-heading"
      data-testid="admin-display-timezone-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-5 dark:border-gdc-border md:px-6">
        <div className="flex min-w-0 gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/[0.07] text-sky-700 dark:border-sky-400/35 dark:bg-sky-500/15 dark:text-sky-100">
            <Clock className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 id="admin-display-timezone-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
              Display timezone
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
              Runtime data and APIs stay in UTC. Review the effective display timezone, then set a personal override or
              (Administrators only) the platform default.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-6 px-4 py-5 md:px-6 md:py-6">
        <div data-testid="admin-display-timezone-current-state" className="space-y-3">
          <p className={sectionStepLabel}>Current state</p>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { term: 'Effective display timezone', detail: resolvedTimezone },
              { term: 'Resolved from', detail: resolutionSource },
              { term: 'Your override', detail: userTimezone ?? 'None' },
              { term: 'Platform default', detail: platformDefaultTimezone },
            ].map((item) => (
              <div key={item.term} className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">{item.term}</dt>
                <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">{item.detail}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-slate-600 dark:text-gdc-muted" data-testid="admin-display-timezone-example">
            Example conversion: <span className="font-medium text-slate-800 dark:text-slate-200">{formatTimestamp(sampleUtc)}</span>
            <span className="text-slate-500 dark:text-gdc-muted"> (from {sampleUtc})</span>
          </p>
        </div>

        <div
          data-testid="admin-display-timezone-personal"
          className="space-y-4 border-t border-slate-100 pt-6 dark:border-gdc-border"
        >
          <div>
            <p className={sectionStepLabel}>Your timezone</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
              Optional personal override. Clear it to fall back to the platform default, then the browser timezone.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className={fieldLabel} htmlFor="user-display-timezone-filter">
                Filter timezones
              </label>
              <p className={fieldHint}>Search by city or region fragment.</p>
              <input
                id="user-display-timezone-filter"
                type="search"
                className={filterClassName}
                value={userFilter}
                disabled={readOnly || busy}
                placeholder="e.g. Los_Angeles or Berlin"
                aria-controls="user-display-timezone"
                onChange={(e) => setUserFilter(e.target.value)}
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="user-display-timezone">
                IANA timezone
              </label>
              <p className={fieldHint}>Leave empty to use platform / browser resolution.</p>
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
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              data-testid="admin-display-timezone-save-user"
              className={cn(gdcUi.primaryBtn, (readOnly || busy) && 'cursor-not-allowed opacity-55')}
              disabled={readOnly || busy}
              onClick={() => void onSaveUser()}
            >
              Save my timezone
            </button>
          </div>
        </div>

        <div
          data-testid="admin-display-timezone-platform"
          className="space-y-4 border-t border-slate-100 pt-6 dark:border-gdc-border"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className={sectionStepLabel}>Platform default</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
                Used when a user has no personal override. Administrator only — Operators and Viewers can still set a
                personal timezone above.
              </p>
            </div>
            {!isAdmin ? (
              <span
                role="status"
                data-testid="admin-display-timezone-platform-locked"
                className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-1 text-xs font-semibold text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
              >
                Administrator only
              </span>
            ) : null}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className={fieldLabel} htmlFor="platform-display-timezone-filter">
                Filter timezones
              </label>
              <p className={fieldHint}>Search before choosing the platform default.</p>
              <input
                id="platform-display-timezone-filter"
                type="search"
                className={filterClassName}
                value={platformFilter}
                disabled={!isAdmin || readOnly || busy}
                placeholder="e.g. Los_Angeles or Berlin"
                aria-controls="platform-display-timezone"
                onChange={(e) => setPlatformFilter(e.target.value)}
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="platform-display-timezone">
                IANA timezone
              </label>
              <p className={fieldHint}>Applies to accounts without a personal override.</p>
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
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              data-testid="admin-display-timezone-save-platform"
              className={cn(
                gdcUi.secondaryBtn,
                (!isAdmin || readOnly || busy) && 'cursor-not-allowed opacity-55',
              )}
              disabled={!isAdmin || readOnly || busy}
              onClick={() => void onSavePlatform()}
            >
              Save platform default
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
