import { AlertTriangle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { runHttpApiTest } from '../../../api/gdcRuntimePreview'
import { cn } from '../../../lib/utils'
import { wizardExtractEvents } from './wizard-json-extract'
import {
  buildApiTestCheckpointPayload,
  buildIncrementalRequestTestSignature,
  calculateIncrementalRequestTestCheckpoint,
  countRecordsNewerThanTestCheckpoint,
  incrementalPreviewKind,
  readCheckpointFromTestRecord,
  resolveCheckpointValuesForTest,
  type IncrementalRequestPattern,
  type IncrementalRequestTestCheckpointResult,
} from './wizard-incremental-request'
import {
  buildSourceAuthPayload,
  buildSourceConfig,
  buildIncrementalTestStreamConfigPayload,
  type WizardCheckpointFieldType,
  type WizardConfigState,
  type WizardIncrementalRequestTestResult,
  type WizardState,
} from './wizard-state'

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatSubstitutedRequest(
  queryParams: Record<string, unknown> | undefined,
  jsonBody: unknown,
  draft: string,
  pattern: IncrementalRequestPattern,
  httpMethod: string,
): string {
  const treatAsQuery =
    incrementalPreviewKind(pattern, draft, httpMethod) === 'query_params'
  if (treatAsQuery) {
    const lines = Object.entries(queryParams ?? {}).map(([k, v]) => `${k}=${String(v)}`)
    return lines.join('\n') || draft
  }
  if (jsonBody != null) {
    return typeof jsonBody === 'string' ? jsonBody : formatJson(jsonBody)
  }
  return draft
}

function NumberBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[9px] font-bold text-white">
      {n}
    </span>
  )
}

export type IncrementalRequestTestHookProps = {
  state: WizardState
  /** Extracted event records (event root applied) used for checkpoint test values. */
  eventSourceRecords: Array<Record<string, unknown>>
  /** Current preview record — enables Test when only one sample exists. */
  previewRecord?: Record<string, unknown> | null
  eventArrayPath: string
  eventRootPath: string
  checkpointSourcePath: string
  checkpointFieldType: WizardCheckpointFieldType
  pattern: IncrementalRequestPattern
  draft: string
  /** Pre-resolved value from the Selected checkpoint "Example" cell (same read path as the UI). */
  resolvedSampleValue?: unknown
  onStreamPatch?: (patch: Partial<WizardConfigState>) => void
}

export type IncrementalRequestTestSectionProps = Pick<
  IncrementalRequestTestHookProps,
  'state' | 'pattern'
> & {
  testDisabled: boolean
  testDisabledReason: string | null
  signature: string
  /** Taller layout for the Request Preview drawer. */
  drawerLayout?: boolean
}

export function useIncrementalRequestTest(props: IncrementalRequestTestHookProps) {
  const {
    state,
    eventSourceRecords,
    previewRecord,
    eventArrayPath,
    eventRootPath,
    checkpointSourcePath,
    checkpointFieldType,
    pattern,
    draft,
    resolvedSampleValue,
    onStreamPatch,
  } = props
  const [testing, setTesting] = useState(false)

  const signature = useMemo(
    () =>
      buildIncrementalRequestTestSignature({
        pattern,
        draft: draft.trim(),
        checkpointSourcePath,
        eventArrayPath,
      }),
    [pattern, draft, checkpointSourcePath, eventArrayPath],
  )

  const checkpointCalc = useMemo((): IncrementalRequestTestCheckpointResult => {
    if (pattern === 'none' || !draft.trim()) {
      return { kind: 'disabled', reason: 'Select an incremental request pattern first.' }
    }
    const values = resolveCheckpointValuesForTest({
      records: eventSourceRecords,
      checkpointSourcePath,
      eventArrayPath,
      eventRootPath,
      previewRecord,
      resolvedSampleValue,
    })
    return calculateIncrementalRequestTestCheckpoint(values, checkpointFieldType)
  }, [
    pattern,
    draft,
    eventSourceRecords,
    previewRecord,
    resolvedSampleValue,
    checkpointSourcePath,
    checkpointFieldType,
    eventArrayPath,
    eventRootPath,
  ])

  const testDisabled =
    pattern === 'none' ||
    !draft.trim() ||
    testing ||
    checkpointCalc.kind !== 'ok'

  const testDisabledReason =
    checkpointCalc.kind === 'disabled'
      ? checkpointCalc.reason
      : pattern === 'none'
        ? 'Select an incremental request pattern first.'
        : !draft.trim()
          ? 'Add a request template first.'
          : null

  useEffect(() => {
    if (!onStreamPatch) return
    const prev = state.stream.incrementalRequestTestResult
    if (!prev) return
    if (prev.signature === signature) return
    onStreamPatch({
      incrementalRequestTestResult: null,
      incrementalRequestTestSignature:
        state.stream.incrementalRequestTestSignature === prev.signature
          ? null
          : state.stream.incrementalRequestTestSignature,
      incrementalRequestTestedAt:
        state.stream.incrementalRequestTestSignature === prev.signature ? null : state.stream.incrementalRequestTestedAt,
    })
  }, [
    signature,
    onStreamPatch,
    state.stream.incrementalRequestTestResult,
    state.stream.incrementalRequestTestSignature,
    state.stream.incrementalRequestTestedAt,
  ])

  const runTest = useCallback(async () => {
    if (testDisabled || checkpointCalc.kind !== 'ok' || !onStreamPatch) return
    setTesting(true)
    const startedAt = Date.now()
    const testState: WizardState = { ...state, stream: { ...state.stream, incrementalRequestDraft: draft } }
    try {
      const res = await runHttpApiTest({
        connector_id: state.connector.connectorId ?? undefined,
        source_config: { ...buildSourceConfig(testState), ...buildSourceAuthPayload(testState) },
        stream_config: buildIncrementalTestStreamConfigPayload(testState),
        checkpoint: buildApiTestCheckpointPayload(checkpointCalc),
        fetch_sample: false,
      })
      const durationMs = res.response?.latency_ms ?? Date.now() - startedAt
      const parsed = res.response?.parsed_json ?? null
      const pathForExtract = eventArrayPath.trim() || state.stream.eventArrayPath.trim()
      const returned = wizardExtractEvents(
        parsed !== null && typeof parsed === 'object' ? parsed : null,
        pathForExtract,
        eventRootPath,
      )
      const substitutedRequestBody = formatSubstitutedRequest(
        res.actual_request_sent?.query_params,
        res.actual_request_sent?.json_body_masked,
        draft,
        pattern,
        state.stream.httpMethod,
      )
      const sampleRecords = returned.slice(0, 2)
      const testedAt = Date.now()
      if (res.ok && res.response) {
        const newerRecordCount = returned.length
          ? countRecordsNewerThanTestCheckpoint(
              returned.map((record) =>
                readCheckpointFromTestRecord(record, checkpointSourcePath, eventArrayPath, eventRootPath),
              ),
              checkpointCalc,
            )
          : null
        // Records at or before the checkpoint do not prove the incremental filter works.
        const noNewerRecords = returned.length > 0 && newerRecordCount === 0
        const result: WizardIncrementalRequestTestResult = {
          status: noNewerRecords ? 'warning' : 'success',
          httpStatus: res.response.status_code,
          durationMs,
          returnedRecordCount: returned.length,
          newerRecordCount,
          warningCode: noNewerRecords ? 'NO_NEWER_RECORDS' : null,
          testedCheckpointDisplay: checkpointCalc.displayValue,
          substitutedRequestBody,
          sampleRecords,
          rawResponseBody: res.response.raw_body ?? null,
          message: noNewerRecords
            ? `Request succeeded and returned ${returned.length} record(s), but none is newer than the tested checkpoint. Verify the request applies the checkpoint filter.`
            : 'Incremental request looks good.',
          testedAt,
          signature,
        }
        onStreamPatch({
          incrementalRequestTestResult: result,
          incrementalRequestTestSignature: signature,
          incrementalRequestTestedAt: testedAt,
        })
      } else {
        const result: WizardIncrementalRequestTestResult = {
          status: 'error',
          httpStatus: res.response?.status_code ?? res.target_status_code ?? null,
          durationMs,
          returnedRecordCount: 0,
          testedCheckpointDisplay: checkpointCalc.displayValue,
          substitutedRequestBody,
          sampleRecords: [],
          rawResponseBody: res.target_response_body ?? res.response?.raw_body ?? res.message ?? null,
          message: 'Incremental request test failed. Fix the request body before creating the stream.',
          testedAt,
          signature,
        }
        onStreamPatch({
          incrementalRequestTestResult: result,
          incrementalRequestTestSignature: null,
          incrementalRequestTestedAt: null,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const result: WizardIncrementalRequestTestResult = {
        status: 'error',
        httpStatus: null,
        durationMs: Date.now() - startedAt,
        returnedRecordCount: 0,
        testedCheckpointDisplay: checkpointCalc.displayValue,
        substitutedRequestBody: draft,
        sampleRecords: [],
        rawResponseBody: message,
        message: 'Incremental request test failed. Fix the request body before creating the stream.',
        testedAt: Date.now(),
        signature,
      }
      onStreamPatch({
        incrementalRequestTestResult: result,
        incrementalRequestTestSignature: null,
        incrementalRequestTestedAt: null,
      })
    } finally {
      setTesting(false)
    }
  }, [
    checkpointCalc,
    checkpointSourcePath,
    draft,
    eventArrayPath,
    eventRootPath,
    onStreamPatch,
    pattern,
    signature,
    state,
    testDisabled,
  ])

  return { testing, testDisabled, testDisabledReason, checkpointCalc, runTest, signature }
}

export function IncrementalRequestTestSection({
  state,
  pattern,
  testDisabled,
  testDisabledReason,
  signature,
  drawerLayout = false,
}: IncrementalRequestTestSectionProps) {
  const [showRaw, setShowRaw] = useState(false)

  const result = state.stream.incrementalRequestTestResult
  const requestSucceeded = result != null && result.status !== 'error'
  const stale =
    requestSucceeded &&
    (result.signature !== signature || state.stream.incrementalRequestTestSignature !== signature)
  const tone = result?.status ?? 'error'

  const codePreClass = drawerLayout
    ? 'gdc-thin-scroll mt-0.5 min-h-[7rem] max-h-[min(22vh,200px)] overflow-auto rounded border border-slate-200/70 bg-slate-950 p-2 font-mono text-[9px] text-emerald-200 dark:border-gdc-border'
    : 'gdc-thin-scroll mt-0.5 max-h-28 overflow-auto rounded border border-slate-200/70 bg-slate-950 p-2 font-mono text-[9px] text-emerald-200 dark:border-gdc-border'
  const samplePreClass = drawerLayout
    ? 'gdc-thin-scroll mt-0.5 min-h-[10rem] max-h-[min(32vh,320px)] overflow-auto rounded border border-slate-200/70 bg-slate-950 p-2 font-mono text-[9px] text-emerald-200 dark:border-gdc-border'
    : 'gdc-thin-scroll mt-0.5 max-h-32 overflow-auto rounded border border-slate-200/70 bg-slate-950 p-2 font-mono text-[9px] text-emerald-200 dark:border-gdc-border'
  const rawPreClass = drawerLayout
    ? 'gdc-thin-scroll mt-0.5 min-h-[8rem] max-h-[min(28vh,260px)] overflow-auto rounded border border-slate-200/70 bg-slate-950 p-2 font-mono text-[9px] text-emerald-200 dark:border-gdc-border'
    : 'gdc-thin-scroll mt-0.5 max-h-32 overflow-auto rounded border border-slate-200/70 bg-slate-950 p-2 font-mono text-[9px] text-emerald-200 dark:border-gdc-border'

  return (
    <div className={cn(drawerLayout && 'flex min-h-0 flex-1 flex-col')}>
      {testDisabled && testDisabledReason && pattern !== 'none' ? (
        <p className="mt-2 text-[10px] text-slate-500 dark:text-gdc-mutedStrong">{testDisabledReason}</p>
      ) : null}

      {pattern !== 'none' ? (
        <p className="mt-1.5 text-[10px] text-slate-500 dark:text-gdc-mutedStrong">
          Test will use the second-latest checkpoint value from the detected records to ensure at least one new record is
          returned.
        </p>
      ) : null}

      {result && result.signature === signature ? (
        <div
          className={cn('space-y-2', drawerLayout ? 'flex min-h-0 flex-1 flex-col' : 'mt-2')}
          data-testid="incremental-request-test-result"
        >
          <div className="flex items-center gap-2">
            <NumberBadge n={4} />
            <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Test result</p>
          </div>
          <div
            data-testid="incremental-request-test-result-status"
            data-status={tone}
            className={cn(
              'rounded-md border px-2.5 py-2',
              drawerLayout && 'flex min-h-0 flex-1 flex-col',
              tone === 'success'
                ? 'border-emerald-300/70 bg-emerald-500/[0.08] dark:border-emerald-500/35 dark:bg-emerald-500/10'
                : tone === 'warning'
                  ? 'border-amber-300/70 bg-amber-500/[0.08] dark:border-amber-500/35 dark:bg-amber-500/10'
                  : 'border-red-300/70 bg-red-500/[0.06] dark:border-red-500/35 dark:bg-red-500/10',
            )}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
              <span
                className={cn(
                  'inline-flex items-center gap-1 font-semibold',
                  tone === 'success'
                    ? 'text-emerald-800 dark:text-emerald-200'
                    : tone === 'warning'
                      ? 'text-amber-800 dark:text-amber-200'
                      : 'text-red-800 dark:text-red-200',
                )}
              >
                {tone === 'warning' ? <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> : null}
                {tone === 'success' ? 'Success' : tone === 'warning' ? 'Warning' : 'Failed'}
                {result.httpStatus != null ? ` · ${result.httpStatus}` : ''}
              </span>
              {result.durationMs != null ? <span className="text-slate-600 dark:text-gdc-mutedStrong">Duration: {result.durationMs}ms</span> : null}
              {requestSucceeded ? (
                <span className="text-slate-600 dark:text-gdc-mutedStrong">Returned records: {result.returnedRecordCount}</span>
              ) : null}
              {requestSucceeded && result.newerRecordCount != null ? (
                <span className="text-slate-600 dark:text-gdc-mutedStrong">
                  Newer than checkpoint: {result.newerRecordCount}
                </span>
              ) : null}
              <span className="text-slate-500 dark:text-gdc-mutedStrong">
                Tested at: {new Date(result.testedAt).toLocaleString()}
              </span>
              {result.rawResponseBody ? (
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  className="ml-auto inline-flex items-center gap-0.5 font-semibold text-violet-700 hover:underline dark:text-violet-300"
                >
                  {showRaw ? 'Hide raw response' : 'See raw response'}
                  {showRaw ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              ) : null}
            </div>
            <p
              className={cn(
                'mt-1.5 text-[11px] font-medium',
                tone === 'success'
                  ? 'text-emerald-900 dark:text-emerald-100'
                  : tone === 'warning'
                    ? 'text-amber-900 dark:text-amber-100'
                    : 'text-red-900 dark:text-red-100',
              )}
            >
              {result.message}
            </p>
            {stale ? (
              <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-800 dark:text-amber-200">
                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                Request template changed after this test — run Test again.
              </p>
            ) : null}
            <dl className={cn('mt-2 space-y-2 text-[10px] text-slate-700 dark:text-slate-200', drawerLayout && 'min-h-0 flex-1')}>
              <div>
                <dt className="font-semibold text-slate-500 dark:text-gdc-mutedStrong">Tested checkpoint (used in request)</dt>
                <dd className="font-mono">{result.testedCheckpointDisplay}</dd>
              </div>
              <div className={cn(drawerLayout && 'min-h-0')}>
                <dt className="font-semibold text-slate-500 dark:text-gdc-mutedStrong">Substituted request body</dt>
                <dd>
                  <pre className={codePreClass}>
                    {result.substitutedRequestBody}
                  </pre>
                </dd>
              </div>
              {requestSucceeded && result.sampleRecords.length > 0 ? (
                <div className={cn(drawerLayout && 'min-h-0 flex-1')}>
                  <dt className="font-semibold text-slate-500 dark:text-gdc-mutedStrong">Sample records (first 2)</dt>
                  <dd>
                    <pre className={samplePreClass}>
                      {formatJson(result.sampleRecords)}
                    </pre>
                  </dd>
                </div>
              ) : null}
              {requestSucceeded && result.rawResponseBody && showRaw ? (
                <div className={cn(drawerLayout && 'min-h-0')}>
                  <dt className="font-semibold text-slate-500 dark:text-gdc-mutedStrong">Raw response body</dt>
                  <dd>
                    <pre className={rawPreClass}>
                      {result.rawResponseBody}
                    </pre>
                  </dd>
                </div>
              ) : null}
              {result.status === 'error' && result.rawResponseBody ? (
                <div className={cn(drawerLayout && 'min-h-0')}>
                  <dt className="font-semibold text-slate-500 dark:text-gdc-mutedStrong">Response / error</dt>
                  <dd>
                    <pre
                      className={cn(
                        drawerLayout
                          ? 'gdc-thin-scroll mt-0.5 min-h-[8rem] max-h-[min(28vh,260px)] overflow-auto rounded border p-2 font-mono text-[9px]'
                          : 'gdc-thin-scroll mt-0.5 max-h-32 overflow-auto rounded border p-2 font-mono text-[9px]',
                        showRaw
                          ? 'border-slate-200/70 bg-slate-950 text-emerald-200 dark:border-gdc-border'
                          : 'border-red-200/70 bg-red-950/40 text-red-100',
                      )}
                    >
                      {showRaw ? result.rawResponseBody : result.rawResponseBody.slice(0, 600)}
                    </pre>
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function IncrementalRequestTestButton({
  testing,
  disabled,
  disabledReason,
  onClick,
}: {
  testing: boolean
  disabled: boolean
  disabledReason?: string | null
  onClick: () => void
}) {
  const inactive = disabled || testing
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        data-testid="incremental-request-test-button"
        onClick={() => {
          if (inactive) return
          void onClick()
        }}
        disabled={inactive}
        title={inactive && disabledReason ? disabledReason : undefined}
        aria-describedby={inactive && disabledReason ? 'incremental-request-test-disabled-reason' : undefined}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] font-semibold transition-colors',
          inactive
            ? 'cursor-not-allowed border border-slate-200/90 bg-slate-200 text-slate-500 dark:border-gdc-border dark:bg-slate-700 dark:text-slate-400'
            : 'bg-violet-600 text-white hover:bg-violet-700',
        )}
      >
        {testing ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        Test
      </button>
      {inactive && disabledReason ? (
        <span
          id="incremental-request-test-disabled-reason"
          className="max-w-[10rem] text-[9px] leading-tight text-slate-500 dark:text-gdc-mutedStrong"
        >
          {disabledReason}
        </span>
      ) : null}
    </span>
  )
}

export { NumberBadge as IncrementalNumberBadge }
