import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_STREAM_DEDUPLICATION_CONFIG,
  fetchStreamDeduplication,
  saveStreamDeduplication,
  streamDeduplicationConfigWithKey,
  type StreamDeduplicationConfig,
} from '../../api/gdcRuntimeUi'

/** The key currently persisted on the stream ('' = deduplication off). */
function persistedKey(config: StreamDeduplicationConfig | null): string {
  if (!config?.enabled) return ''
  return String(config.key_field === 'custom_jsonpath' ? config.custom_jsonpath ?? '' : config.key_field ?? '')
}

type Props = {
  streamId: number
  /** Deduplication changes the running pipeline, so it follows the Edit page's stop-first rule. */
  running: boolean
  readOnly?: boolean
}

/**
 * Discoverable Deduplication control on the stream Edit page (manifest `wizard.feature.dedup`, F-132).
 * Before this, the only surface was a field inside the legacy API Test page that nothing linked to.
 */
export function StreamDeduplicationCard({ streamId, running, readOnly = false }: Props) {
  const [loaded, setLoaded] = useState(false)
  const [config, setConfig] = useState<StreamDeduplicationConfig | null>(null)
  const [draftKey, setDraftKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const current = await fetchStreamDeduplication(streamId)
      if (cancelled) return
      setConfig(current)
      setDraftKey(persistedKey(current))
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [streamId])

  const savedKey = persistedKey(config)
  const dirty = draftKey.trim() !== savedKey.trim()
  const blockedReason = readOnly
    ? 'You do not have permission to change deduplication.'
    : running
      ? 'Stop the stream before changing deduplication.'
      : null

  const save = useCallback(async () => {
    if (blockedReason) return
    setBusy(true)
    setMessage(null)
    try {
      const wanted = streamDeduplicationConfigWithKey(config ?? DEFAULT_STREAM_DEDUPLICATION_CONFIG, draftKey)
      await saveStreamDeduplication(streamId, wanted)
      const readBack = await fetchStreamDeduplication(streamId)
      if (!readBack || readBack.enabled !== wanted.enabled) {
        throw new Error(
          `Deduplication was not ${wanted.enabled ? 'enabled' : 'disabled'}: the stream still reports it ${readBack?.enabled ? 'on' : 'off'}.`,
        )
      }
      setConfig(readBack)
      setDraftKey(persistedKey(readBack))
      setMessage({ tone: 'ok', text: wanted.enabled ? 'Deduplication saved and confirmed.' : 'Deduplication turned off.' })
    } catch (error) {
      setMessage({ tone: 'err', text: error instanceof Error ? error.message : 'Could not save deduplication.' })
    } finally {
      setBusy(false)
    }
  }, [blockedReason, config, draftKey, streamId])

  return (
    <section
      className="mt-4 rounded-lg border border-slate-200/80 bg-white p-3 text-[12px] dark:border-gdc-border dark:bg-gdc-card"
      aria-labelledby="stream-dedup-heading"
      data-testid="stream-dedup-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="stream-dedup-heading" className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
          Deduplication
        </h3>
        <span className="text-[11px] text-slate-500 dark:text-gdc-mutedStrong" data-testid="stream-dedup-state">
          {!loaded ? 'Loading…' : savedKey ? `On · key ${savedKey}` : 'Off'}
        </span>
      </div>
      <p className="mt-1 text-slate-600 dark:text-gdc-muted">
        Skip events whose key was already seen (scope: {config?.scope ?? 'current_run'}). Leave the key empty to turn
        deduplication off. Use a field name such as <code>event_id</code> or a JSONPath such as <code>$.id</code>.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="block min-w-[14rem] flex-1">
          <span className="font-medium text-slate-700 dark:text-slate-200">Deduplication key</span>
          <input
            type="text"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            disabled={!loaded || busy || blockedReason != null}
            placeholder="event_id or $.id (empty = off)"
            data-testid="stream-dedup-key-input"
            className="mt-1 h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-[11px] disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
          />
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!loaded || busy || !dirty || blockedReason != null}
          data-testid="stream-dedup-save"
          className="inline-flex h-8 items-center rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save deduplication'}
        </button>
      </div>
      {blockedReason ? (
        <p className="mt-1 text-amber-700 dark:text-amber-300" data-testid="stream-dedup-blocked">
          {blockedReason}
        </p>
      ) : null}
      {message ? (
        <p
          role={message.tone === 'err' ? 'alert' : 'status'}
          className={message.tone === 'err' ? 'mt-1 text-red-700 dark:text-red-300' : 'mt-1 text-emerald-700 dark:text-emerald-300'}
          data-testid="stream-dedup-message"
        >
          {message.text}
        </p>
      ) : null}
    </section>
  )
}
