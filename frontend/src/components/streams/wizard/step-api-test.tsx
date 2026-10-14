import { AlertCircle, CheckCircle2, Loader2, Play } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { runHttpApiTest, runConnectorAuthTest, type ConnectorAuthTestResponse, type HttpApiTestAnalysisPayload } from '../../../api/gdcRuntimePreview'
import { WIZARD_LABEL } from '../../../lib/operator-vocabulary'
import { cn } from '../../../lib/utils'
import { validateJsonBodyForApi } from '../../../utils/jsonBodySyntax'
import {
  buildFullRequestUrl,
  buildSourceAuthPayload,
  buildSourceConfig,
  buildStreamConfigPayload,
  INITIAL_API_TEST,
  type WizardApiTestStep,
  type WizardApiTestState,
  type WizardConfigState,
  type WizardHttpApiAnalysis,
  type WizardState,
} from './wizard-state'
import { detectEventRootCandidates, flattenSampleFields } from './wizard-json-extract'
import { buildApiTestSuccessPatch } from '../../../utils/wizardUnionSchema'
import { resolveHttpApiTestResult } from './wizard-step-gates'
import type { OperationalSampleId } from './wizard-operational-samples'
import { resolveSourceTypePresentation } from '../../../utils/sourceTypePresentation'
type StepApiTestProps = {
  state: WizardState
  onChange: (next: WizardApiTestState) => void
  /** Suggested paths only — never persisted without explicit user confirmation (Charter v3). */
  onStreamPatch?: (patch: Partial<WizardConfigState>) => void
  onLoadOperationalSample?: (id: OperationalSampleId) => void
  activeOperationalSampleId?: OperationalSampleId | null
  /** Jump to Record Selection after a successful run test. */
  onAdvanceToRecordSelection?: () => void
}

function mapApiAnalysis(a: HttpApiTestAnalysisPayload): WizardHttpApiAnalysis {
  return {
    responseSummary: {
      root_type: a.response_summary.root_type,
      approx_size_bytes: a.response_summary.approx_size_bytes,
      top_level_keys: a.response_summary.top_level_keys ?? [],
      item_count_root: a.response_summary.item_count_root ?? null,
      truncation: a.response_summary.truncation ?? null,
    },
    detectedArrays: (a.detected_arrays ?? []).map((x) => ({
      path: x.path,
      count: x.count,
      confidence: x.confidence,
      reason: x.reason,
      sample_item_preview: x.sample_item_preview,
    })),
    detectedCheckpointCandidates: (a.detected_checkpoint_candidates ?? []).map((x) => ({
      path: x.field_path,
      checkpoint_type: x.checkpoint_type,
      confidence: x.confidence,
      sample_value: x.sample_value,
      reason: x.reason ?? '',
    })),
    sampleEvent: a.sample_event,
    selectedEventArrayDefault: a.selected_event_array_default ?? null,
    flatPreviewFields: a.flat_preview_fields ?? [],
    eventRootCandidates: detectEventRootCandidates(a.sample_event),
    previewError: a.preview_error ?? null,
  }
}

function mapApiSteps(
  steps: Array<{ name: string; success: boolean; status_code?: number | null; message?: string }> | undefined,
): WizardApiTestStep[] {
  if (!steps?.length) return []
  return steps.map((s) => ({
    name: s.name,
    success: s.success,
    status_code: s.status_code ?? null,
    message: s.message ?? '',
  }))
}

function databaseSampleRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(
    (row): row is Record<string, unknown> =>
      row != null && typeof row === 'object' && !Array.isArray(row),
  )
}

function databaseSampleFieldTypes(rows: Array<Record<string, unknown>>): Array<{ name: string; type: string }> {
  const byField = new Map<string, Set<string>>()
  for (const row of rows.slice(0, 25)) {
    for (const [name, value] of Object.entries(row)) {
      const type =
        value == null
          ? 'null'
          : Array.isArray(value)
            ? 'array'
            : typeof value === 'object'
              ? 'object'
              : typeof value
      const types = byField.get(name) ?? new Set<string>()
      types.add(type)
      byField.set(name, types)
    }
  }
  return [...byField.entries()].map(([name, types]) => ({
    name,
    type: types.size === 1 ? [...types][0] ?? 'unknown' : `mixed(${[...types].join('|')})`,
  }))
}

function databaseCellDisplay(value: unknown): string {
  if (value == null) return 'null'
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const text = JSON.stringify(value)
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return '[value unavailable]'
  }
}

type HttpFailureStage = 'Request' | 'Connection' | 'Authentication' | 'Response'

type ParsedWebhookPreview = {
  payload: Record<string, unknown> | Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
  analysis: WizardHttpApiAnalysis
}

function parseWebhookPayloadPreview(raw: string): ParsedWebhookPreview {
  const text = raw.trim()
  if (!text) throw new Error('No saved sample payload.')

  let payload: unknown
  let ndjson = false
  try {
    payload = JSON.parse(text)
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length < 2) throw new Error('Sample must be a JSON object, JSON array, or NDJSON records.')
    const rows = lines.map((line, index) => {
      try {
        const value = JSON.parse(line)
        if (typeof value !== 'object' || value == null || Array.isArray(value)) {
          throw new Error('NDJSON line ' + (index + 1) + ' must be a JSON object.')
        }
        return value as Record<string, unknown>
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('NDJSON line')) throw error
        throw new Error('Invalid NDJSON at line ' + (index + 1) + '.')
      }
    })
    payload = rows
    ndjson = true
  }

  const events =
    Array.isArray(payload)
      ? payload.filter((row): row is Record<string, unknown> => typeof row === 'object' && row != null && !Array.isArray(row))
      : typeof payload === 'object' && payload != null
        ? [payload as Record<string, unknown>]
        : []

  if (
    typeof payload !== 'object' ||
    payload == null ||
    (Array.isArray(payload) && events.length !== payload.length)
  ) {
    throw new Error('Webhook sample records must be JSON objects.')
  }

  const sampleEvent = events[0] ?? null
  const serialized = JSON.stringify(payload)
  return {
    payload: payload as Record<string, unknown> | Array<Record<string, unknown>>,
    events,
    analysis: {
      responseSummary: {
        root_type: Array.isArray(payload) ? (ndjson ? 'ndjson' : 'array') : 'object',
        approx_size_bytes: serialized.length,
        top_level_keys: Array.isArray(payload) ? [] : Object.keys(payload as Record<string, unknown>),
        item_count_root: Array.isArray(payload) ? payload.length : null,
        truncation: null,
      },
      detectedArrays: Array.isArray(payload)
        ? [{ path: '$', count: events.length, confidence: 1, reason: ndjson ? 'saved webhook NDJSON preview' : 'saved webhook JSON array preview', sample_item_preview: sampleEvent }]
        : [],
      detectedCheckpointCandidates: [],
      sampleEvent,
      selectedEventArrayDefault: Array.isArray(payload) ? '$' : null,
      flatPreviewFields: flattenSampleFields(sampleEvent),
      eventRootCandidates: detectEventRootCandidates(sampleEvent),
      previewError: null,
    },
  }
}

function webhookAuthSummary(
  mode: string,
  headerName: string,
  sharedSecretConfigured: boolean,
  bearerTokenConfigured: boolean,
): string {
  if (mode === 'shared_secret_header') {
    return 'Shared secret header (' + (headerName || 'X-GDC-Webhook-Secret') + ') · ' + (sharedSecretConfigured ? 'configured' : 'not configured')
  }
  if (mode === 'bearer_token') {
    return 'Bearer token · ' + (bearerTokenConfigured ? 'configured' : 'not configured')
  }
  return 'No auth'
}

function resolveHttpFailureStage(
  code: string | null,
  errorType: string | null,
  targetStatusCode: number | null,
): HttpFailureStage {
  const signal = `${code ?? ''} ${errorType ?? ''}`.toLowerCase()
  if (
    signal.includes('auth') ||
    signal.includes('token') ||
    signal.includes('login') ||
    signal.includes('unauthorized') ||
    signal.includes('forbidden') ||
    signal.includes('session_not_acquired')
  ) {
    return 'Authentication'
  }
  if (
    signal.includes('connection') ||
    signal.includes('network') ||
    signal.includes('timeout') ||
    signal.includes('ssl') ||
    signal.includes('certificate') ||
    signal.includes('invalid_test_url')
  ) {
    return 'Connection'
  }
  if (
    targetStatusCode != null ||
    signal.includes('response') ||
    signal.includes('http_error') ||
    signal.includes('unsupported_content_type')
  ) {
    return 'Response'
  }
  return 'Request'
}

export function StepApiTest({
  state,
  onChange,
  onStreamPatch: _onStreamPatch,
  onAdvanceToRecordSelection,
}: StepApiTestProps) {
  const [busy, setBusy] = useState(false)
  const requestGenRef = useRef(0)

  const apiTestConfigFingerprint = useMemo(
    () =>
      JSON.stringify({
        connectorId: state.connector.connectorId,
        sourceId: state.connector.sourceId,
        sourceType: state.connector.sourceType,
        hostBaseUrl: state.connector.hostBaseUrl,
        endpoint: state.stream.endpoint,
        httpMethod: state.stream.httpMethod,
        requestBody: state.stream.requestBody,
        params: state.stream.params,
        headers: state.stream.headers,
        remoteDirectory: state.stream.remoteDirectory,
        filePattern: state.stream.filePattern,
        remoteRecursive: state.stream.remoteRecursive,
        sqlQuery: state.stream.sqlQuery,
        dbQueryParams: state.stream.dbQueryParams,
        webhookReceiverPath: state.connector.webhookReceiverPath,
        webhookAuthMode: state.connector.webhookAuthMode,
        webhookAuthHeaderName: state.connector.webhookAuthHeaderName,
        webhookSharedSecretConfigured: state.connector.webhookSharedSecretConfigured,
        webhookBearerTokenConfigured: state.connector.webhookBearerTokenConfigured,
        webhookMaxRequestBytes: state.connector.webhookMaxRequestBytes,
        webhookPayloadPreview: state.connector.webhookPayloadPreview,
      }),
    [
      state.connector.connectorId,
      state.connector.sourceId,
      state.connector.sourceType,
      state.connector.hostBaseUrl,
      state.stream.endpoint,
      state.stream.httpMethod,
      state.stream.requestBody,
      state.stream.params,
      state.stream.headers,
      state.stream.remoteDirectory,
      state.stream.filePattern,
      state.stream.remoteRecursive,
      state.stream.sqlQuery,
      state.stream.dbQueryParams,
      state.connector.webhookReceiverPath,
      state.connector.webhookAuthMode,
      state.connector.webhookAuthHeaderName,
      state.connector.webhookSharedSecretConfigured,
      state.connector.webhookBearerTokenConfigured,
      state.connector.webhookMaxRequestBytes,
      state.connector.webhookPayloadPreview,
    ],
  )

  // Stamp draft-hydrated results with the current config once; clear only when config drifts.
  useEffect(() => {
    const status = state.apiTest.status
    if (status !== 'success' && status !== 'error' && status !== 'running') return
    const stored = state.apiTest.configFingerprint ?? null
    if (stored == null && (status === 'success' || status === 'error')) {
      onChange({ ...state.apiTest, configFingerprint: apiTestConfigFingerprint })
      return
    }
    if (stored != null && stored !== apiTestConfigFingerprint) {
      requestGenRef.current += 1
      onChange({
        ...INITIAL_API_TEST,
        status: 'idle',
        ok: false,
        configFingerprint: null,
      })
      setBusy(false)
    }
  }, [apiTestConfigFingerprint, onChange, state.apiTest])

  const commitApiTest = useCallback(
    (gen: number, next: WizardApiTestState) => {
      if (gen !== requestGenRef.current) return
      onChange({
        ...next,
        configFingerprint: apiTestConfigFingerprint,
      })
    },
    [apiTestConfigFingerprint, onChange],
  )

  const sourcePres = useMemo(
    () => resolveSourceTypePresentation(state.connector.sourceType),
    [state.connector.sourceType],
  )

  const isS3 = state.connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isWebhook = state.connector.sourceType === 'WEBHOOK_RECEIVER'
  const isDatabase = state.connector.sourceType === 'DATABASE_QUERY'
  const isHttp = !isS3 && !isRemote && !isWebhook && !isDatabase
  const canRunLiveApiTest = useMemo(
    () =>
      state.connector.connectorId != null &&
      state.connector.sourceId != null &&
      (isS3 ||
        isWebhook ||
        (isRemote && state.stream.remoteDirectory.trim().length > 0) ||
        (isDatabase && state.stream.sqlQuery.trim().length > 0) ||
        (!isS3 && !isRemote && !isWebhook && !isDatabase && state.stream.endpoint.trim().length > 0)),
    [
      state.connector.connectorId,
      state.connector.sourceId,
      state.connector.sourceType,
      state.stream.endpoint,
      state.stream.remoteDirectory,
      state.stream.sqlQuery,
      isS3,
      isRemote,
      isWebhook,
      isDatabase,
    ],
  )

  const run = useCallback(async () => {
    if (busy || !canRunLiveApiTest) return
    const gen = ++requestGenRef.current

    if (state.connector.sourceType === 'S3_OBJECT_POLLING') {
      setBusy(true)
      const startedAt = Date.now()
      commitApiTest(gen, {
        ...state.apiTest,
        status: 'running',
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorType: null,
        errorMessage: null,
        s3ConnectivityPassed: false,
        extractedEvents: [],
        eventCount: 0,
        unionSchema: null,
        analysis: null,
      })
      let connectivityPassed = false
      try {
        const res = await runConnectorAuthTest({
          connector_id: state.connector.connectorId ?? undefined,
          method: 'GET',
          test_path: '/',
        })
        if (!res.ok) {
          commitApiTest(gen, {
            status: 'error',
            ok: false,
            requestUrl: null,
            method: 'GET',
            statusCode: null,
            responseHeaders: {},
            rawBody: JSON.stringify(res, null, 2),
            parsedJson: null,
            rawResponse: res,
            extractedEvents: [],
            eventCount: 0,
            unionSchema: null,
            startedAt,
            finishedAt: Date.now(),
            errorCode: res.error_type ?? 's3_probe_failed',
            errorType: res.error_type ?? 's3_probe_failed',
            errorMessage: res.message ?? 'S3 connectivity probe failed',
            targetStatusCode: null,
            targetResponseBody: null,
            hint: 'Verify endpoint URL, bucket, credentials, and IAM (s3:ListBucket, s3:GetObject).',
            apiBacked: true,
            steps: [],
            responseSample: null,
            effectiveHeadersMasked: null,
            actualRequestSent: null,
            analysis: null,
            s3ConnectivityPassed: false,
          })
          return
        }
        connectivityPassed = true
        const sampleRes = await runHttpApiTest({
          connector_id: state.connector.connectorId ?? undefined,
          source_config: { ...buildSourceConfig(state), ...buildSourceAuthPayload(state) },
          stream_config: buildStreamConfigPayload(state),
          checkpoint: null,
          fetch_sample: true,
        })
        const parsedBody = sampleRes.response?.parsed_json ?? null
        const analysisModel = sampleRes.analysis ? mapApiAnalysis(sampleRes.analysis) : null
        commitApiTest(gen, {
          status: 'success',
          ok: true,
          requestUrl: sampleRes.request.url,
          method: sampleRes.request.method,
          statusCode: sampleRes.response?.status_code ?? 200,
          responseHeaders: sampleRes.response?.headers ?? {},
          rawBody: sampleRes.response?.raw_body ?? null,
          parsedJson: parsedBody,
          rawResponse: parsedBody ?? sampleRes.response?.raw_body ?? null,
          ...buildApiTestSuccessPatch(parsedBody, analysisModel),
          startedAt,
          finishedAt: Date.now(),
          errorCode: null,
          errorType: null,
          errorMessage: null,
          targetStatusCode: null,
          targetResponseBody: null,
          hint:
            res.s3_object_count_preview === 0
              ? 'S3 connectivity is healthy, but no matching objects were available for the sample.'
              : 'S3 connectivity verified and sample fields were parsed from actual matching object data.',
          apiBacked: true,
          steps: mapApiSteps(sampleRes.steps),
          responseSample: parsedBody,
          effectiveHeadersMasked: sampleRes.request.headers_masked ?? null,
          actualRequestSent: sampleRes.actual_request_sent
            ? {
                method: sampleRes.actual_request_sent.method,
                url: sampleRes.actual_request_sent.url,
                endpoint: sampleRes.actual_request_sent.endpoint ?? null,
                queryParams: sampleRes.actual_request_sent.query_params ?? {},
                headersMasked: sampleRes.actual_request_sent.headers_masked ?? {},
                jsonBodyMasked: sampleRes.actual_request_sent.json_body_masked ?? null,
                timeoutSeconds: sampleRes.actual_request_sent.timeout_seconds,
              }
            : null,
          analysis: analysisModel,
          s3ConnectivityPassed: true,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : connectivityPassed ? 'S3 sample fetch failed.' : 'S3 probe failed.'
        commitApiTest(gen, {
          status: 'error',
          ok: false,
          requestUrl: null,
          method: null,
          statusCode: null,
          responseHeaders: {},
          rawBody: null,
          parsedJson: null,
          rawResponse: null,
          extractedEvents: [],
          eventCount: 0,
          unionSchema: null,
          startedAt,
          finishedAt: Date.now(),
          errorCode: 's3_probe_exception',
          errorType: 's3_probe_exception',
          errorMessage: message,
          targetStatusCode: null,
          targetResponseBody: null,
          hint: null,
          apiBacked: true,
          steps: [],
          responseSample: null,
          effectiveHeadersMasked: null,
          actualRequestSent: null,
          analysis: null,
          s3ConnectivityPassed: false,
        })
      } finally {
        if (gen === requestGenRef.current) setBusy(false)
      }
      return
    }

    if (isRemote) {
      setBusy(true)
      const startedAt = Date.now()
      commitApiTest(gen, {
        ...state.apiTest,
        status: 'running',
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorType: null,
        errorMessage: null,
        targetStatusCode: null,
        targetResponseBody: null,
        hint: null,
        requestUrl: null,
        method: null,
        statusCode: null,
        responseHeaders: {},
        rawBody: null,
        parsedJson: null,
        steps: [],
        responseSample: null,
        effectiveHeadersMasked: null,
        analysis: null,
        actualRequestSent: null,
        s3ConnectivityPassed: false,
        remoteProbe: null,
      })
      let lastProbe: ConnectorAuthTestResponse | null = null
      try {
        const probe = await runConnectorAuthTest({
          connector_id: state.connector.connectorId ?? undefined,
          method: 'GET',
          test_path: '/',
          remote_file_stream_config: {
            remote_directory: state.stream.remoteDirectory.trim(),
            file_pattern: (state.stream.filePattern.trim() || '*') as string,
            recursive: state.stream.remoteRecursive,
          },
        })
        if (!probe.ok) {
          commitApiTest(gen, {
            status: 'error',
            ok: false,
            requestUrl: null,
            method: 'REMOTE_FILE_POLLING',
            statusCode: null,
            responseHeaders: {},
            rawBody: null,
            parsedJson: null,
            rawResponse: probe,
            extractedEvents: [],
            eventCount: 0,
            unionSchema: null,
            startedAt,
            finishedAt: Date.now(),
            errorCode: probe.error_type ?? 'remote_probe_failed',
            errorType: probe.error_type ?? 'remote_probe_failed',
            errorMessage: probe.message ?? 'Remote file connectivity probe failed',
            targetStatusCode: null,
            targetResponseBody: null,
            hint: 'Verify SSH host, credentials, known_hosts policy, and remote_directory.',
            apiBacked: true,
            steps: [],
            responseSample: null,
            effectiveHeadersMasked: null,
            actualRequestSent: null,
            analysis: null,
            s3ConnectivityPassed: false,
            remoteProbe: probe,
          })
          return
        }
        lastProbe = probe
        const res = await runHttpApiTest({
          connector_id: state.connector.connectorId ?? undefined,
          source_config: { ...buildSourceConfig(state), ...buildSourceAuthPayload(state) },
          stream_config: buildStreamConfigPayload(state),
          checkpoint: null,
          fetch_sample: true,
        })
        const parsedBody = res.response?.parsed_json ?? null
        const probeShapedSample =
          parsedBody != null &&
          typeof parsedBody === 'object' &&
          !Array.isArray(parsedBody) &&
          ('ssh_reachable' in (parsedBody as object) || 'sftp_available' in (parsedBody as object))
        if (probeShapedSample || (Array.isArray(parsedBody) && parsedBody.length === 0)) {
          commitApiTest(gen, {
            status: 'success',
            ok: true,
            requestUrl: res.request.url,
            method: 'REMOTE_FILE_POLLING',
            statusCode: res.response?.status_code ?? 200,
            responseHeaders: res.response?.headers ?? {},
            rawBody: res.response?.raw_body ?? null,
            parsedJson: parsedBody,
            rawResponse: parsedBody ?? res.response?.raw_body ?? null,
            extractedEvents: [],
            eventCount: 0,
            unionSchema: null,
            startedAt,
            finishedAt: Date.now(),
            errorCode: null,
            errorType: null,
            errorMessage: null,
            targetStatusCode: null,
            targetResponseBody: null,
            hint: 'Remote connectivity succeeded. File events were not returned yet — Destinations can still proceed. Verify directory and file pattern if you expected sample rows.',
            apiBacked: true,
            steps: mapApiSteps(res.steps),
            responseSample: parsedBody,
            effectiveHeadersMasked: res.request.headers_masked ?? null,
            actualRequestSent: null,
            analysis: null,
            s3ConnectivityPassed: false,
            remoteProbe: probe,
          })
          return
        }
        let analysisModel = res.analysis ? mapApiAnalysis(res.analysis) : null
        if (
          !analysisModel &&
          Array.isArray(parsedBody) &&
          parsedBody.length > 0 &&
          typeof parsedBody[0] === 'object' &&
          parsedBody[0] !== null &&
          !Array.isArray(parsedBody[0])
        ) {
          const fe = parsedBody[0] as Record<string, unknown>
          analysisModel = {
            responseSummary: {
              root_type: 'array',
              approx_size_bytes: JSON.stringify(parsedBody).length,
              top_level_keys: [],
              item_count_root: parsedBody.length,
              truncation: null,
            },
            detectedArrays: [],
            detectedCheckpointCandidates: [],
            sampleEvent: fe,
            selectedEventArrayDefault: '$',
            flatPreviewFields: flattenSampleFields(fe),
            eventRootCandidates: detectEventRootCandidates(fe),
            previewError: null,
          }
        }
        const statusCode = res.response?.status_code ?? null
        const hasPayload = parsedBody != null || (res.response?.raw_body ?? null) != null
        const outcome = resolveHttpApiTestResult(statusCode, hasPayload)
        const samplePatch = outcome.ok ? buildApiTestSuccessPatch(parsedBody, analysisModel) : buildApiTestSuccessPatch(null, null)
        commitApiTest(gen, {
          status: outcome.status,
          ok: outcome.ok,
          requestUrl: res.request.url,
          method: res.request.method,
          statusCode,
          responseHeaders: res.response?.headers ?? {},
          rawBody: res.response?.raw_body ?? null,
          parsedJson: parsedBody,
          rawResponse: parsedBody ?? res.response?.raw_body ?? null,
          ...samplePatch,
          startedAt,
          finishedAt: Date.now(),
          errorCode: outcome.ok ? null : 'http_error',
          errorType: outcome.ok ? null : 'http_error',
          errorMessage: outcome.ok
            ? null
            : statusCode != null && statusCode >= 400
              ? `HTTP ${statusCode} response — sample fetch did not succeed.`
              : 'No response payload returned.',
          targetStatusCode: outcome.ok ? null : statusCode,
          targetResponseBody: outcome.ok ? null : res.response?.raw_body ?? null,
          hint: outcome.ok ? null : 'Fix upstream errors or adjust the request, then retry API Test.',
          apiBacked: true,
          steps: mapApiSteps(res.steps),
          responseSample: parsedBody,
          effectiveHeadersMasked: res.request.headers_masked ?? null,
          actualRequestSent: res.actual_request_sent
            ? {
                method: res.actual_request_sent.method,
                url: res.actual_request_sent.url,
                endpoint: res.actual_request_sent.endpoint ?? null,
                queryParams: res.actual_request_sent.query_params ?? {},
                headersMasked: res.actual_request_sent.headers_masked ?? {},
                jsonBodyMasked: res.actual_request_sent.json_body_masked ?? null,
                timeoutSeconds: res.actual_request_sent.timeout_seconds,
              }
            : null,
          analysis: outcome.ok ? analysisModel : state.apiTest.analysis,
          s3ConnectivityPassed: false,
          remoteProbe: probe,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Remote file sample fetch failed.'
        if (lastProbe?.ok) {
          commitApiTest(gen, {
            status: 'error',
            ok: false,
            requestUrl: null,
            method: 'REMOTE_FILE_POLLING',
            statusCode: null,
            responseHeaders: {},
            rawBody: null,
            parsedJson: null,
            rawResponse: lastProbe,
            extractedEvents: [],
            eventCount: 0,
            unionSchema: null,
            startedAt,
            finishedAt: Date.now(),
            errorCode: 'remote_file_sample_fetch_failed',
            errorType: 'remote_file_sample_fetch_failed',
            errorMessage: message,
            targetStatusCode: null,
            targetResponseBody: null,
            hint: 'SSH/SFTP connectivity succeeded. Verify directory, file pattern, parser format, and file contents before retrying.',
            apiBacked: true,
            steps: [],
            responseSample: lastProbe,
            effectiveHeadersMasked: null,
            actualRequestSent: null,
            analysis: null,
            s3ConnectivityPassed: false,
            remoteProbe: lastProbe,
          })
        } else {
        commitApiTest(gen, {
          status: 'error',
          ok: false,
          requestUrl: null,
          method: null,
          statusCode: null,
          responseHeaders: {},
          rawBody: null,
          parsedJson: null,
          rawResponse: null,
          extractedEvents: [],
          eventCount: 0,
          unionSchema: null,
          startedAt,
          finishedAt: Date.now(),
          errorCode: 'remote_file_fetch_exception',
          errorType: 'remote_file_fetch_exception',
          errorMessage: message,
          targetStatusCode: null,
          targetResponseBody: null,
          hint: null,
          apiBacked: true,
          steps: [],
          responseSample: null,
          effectiveHeadersMasked: null,
          actualRequestSent: null,
          analysis: null,
          s3ConnectivityPassed: false,
          remoteProbe: lastProbe,
        })
        }
      } finally {
        if (gen === requestGenRef.current) setBusy(false)
      }
      return
    }

    if (isWebhook) {
      setBusy(true)
      const startedAt = Date.now()
      commitApiTest(gen, {
        ...state.apiTest,
        status: 'running',
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorType: null,
        errorMessage: null,
      })
      try {
        const sampleText = state.connector.webhookPayloadPreview.trim()
        if (!sampleText) {
          commitApiTest(gen, {
            status: 'success',
            ok: true,
            requestUrl: state.connector.webhookReceiverPath || null,
            method: 'WEBHOOK_RECEIVER',
            statusCode: null,
            responseHeaders: {},
            rawBody: null,
            parsedJson: null,
            rawResponse: null,
            extractedEvents: [],
            eventCount: 0,
            unionSchema: null,
            startedAt,
            finishedAt: Date.now(),
            errorCode: null,
            errorType: null,
            errorMessage: null,
            targetStatusCode: null,
            targetResponseBody: null,
            hint: 'Receiver configuration is saved. Waiting for a producer event is normal and is not a connector failure. Add a representative payload preview to validate mapping before live traffic.',
            apiBacked: false,
            steps: [],
            responseSample: null,
            effectiveHeadersMasked: null,
            actualRequestSent: null,
            analysis: null,
            s3ConnectivityPassed: false,
            remoteProbe: null,
          })
          return
        }

        const parsed = parseWebhookPayloadPreview(sampleText)
        commitApiTest(gen, {
          status: 'success',
          ok: true,
          requestUrl: state.connector.webhookReceiverPath || null,
          method: 'WEBHOOK_RECEIVER',
          statusCode: null,
          responseHeaders: {},
          rawBody: sampleText,
          parsedJson: parsed.payload,
          rawResponse: parsed.payload,
          extractedEvents: parsed.events,
          eventCount: parsed.events.length,
          unionSchema: null,
          startedAt,
          finishedAt: Date.now(),
          errorCode: null,
          errorType: null,
          errorMessage: null,
          targetStatusCode: null,
          targetResponseBody: null,
          hint: 'Validated the saved synthetic payload locally. Live producers POST to the saved receiver URL and use the same mapping, Route, and delivery pipeline.',
          apiBacked: false,
          steps: [],
          responseSample: parsed.payload,
          effectiveHeadersMasked: null,
          actualRequestSent: null,
          analysis: parsed.analysis,
          s3ConnectivityPassed: false,
          remoteProbe: null,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Webhook sample preview is invalid.'
        commitApiTest(gen, {
          status: 'error',
          ok: false,
          requestUrl: state.connector.webhookReceiverPath || null,
          method: 'WEBHOOK_RECEIVER',
          statusCode: null,
          responseHeaders: {},
          rawBody: state.connector.webhookPayloadPreview,
          parsedJson: null,
          rawResponse: null,
          extractedEvents: [],
          eventCount: 0,
          unionSchema: null,
          startedAt,
          finishedAt: Date.now(),
          errorCode: 'invalid_webhook_sample',
          errorType: 'invalid_webhook_sample',
          errorMessage: message,
          targetStatusCode: null,
          targetResponseBody: null,
          hint: 'Fix the saved webhook payload preview. Runtime accepts a JSON object, JSON array of objects, or NDJSON objects.',
          apiBacked: false,
          steps: [],
          responseSample: null,
          effectiveHeadersMasked: null,
          actualRequestSent: null,
          analysis: null,
          s3ConnectivityPassed: false,
          remoteProbe: null,
        })
      } finally {
        if (gen === requestGenRef.current) setBusy(false)
      }
      return
    }

    const syntax = isDatabase ? ({ ok: true } as const) : validateJsonBodyForApi(state.stream.requestBody)
    if (syntax.ok === false) {
      const startedAt = Date.now()
      commitApiTest(gen, {
        status: 'error',
        ok: false,
        requestUrl: null,
        method: null,
        statusCode: null,
        responseHeaders: {},
        rawBody: null,
        parsedJson: null,
        rawResponse: null,
        extractedEvents: [],
        eventCount: 0,
        unionSchema: null,
        startedAt,
        finishedAt: startedAt,
        errorCode: 'invalid_json_body',
        errorType: 'invalid_json_body',
        errorMessage: syntax.message,
        targetStatusCode: null,
        targetResponseBody: null,
        hint: 'Fix JSON syntax on the HTTP Request step, then retry.',
        apiBacked: false,
        steps: [],
        responseSample: null,
        effectiveHeadersMasked: null,
        actualRequestSent: null,
        analysis: null,
        s3ConnectivityPassed: false,
      })
      return
    }
    setBusy(true)
    const startedAt = Date.now()
      commitApiTest(gen, {
        ...state.apiTest,
        status: 'running',
        ok: false,
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorType: null,
        errorMessage: null,
        targetStatusCode: null,
        targetResponseBody: null,
        hint: null,
      })
    try {
      const res = await runHttpApiTest({
        connector_id: state.connector.connectorId ?? undefined,
        source_config: { ...buildSourceConfig(state), ...buildSourceAuthPayload(state) },
        stream_config: buildStreamConfigPayload(state),
        checkpoint: null,
        fetch_sample: true,
      })
      const parsedBody = res.response?.parsed_json ?? null
      const analysisModel = res.analysis ? mapApiAnalysis(res.analysis) : null
      const statusCode = res.response?.status_code ?? null
      const hasPayload = parsedBody != null || (res.response?.raw_body ?? null) != null
      const outcome = resolveHttpApiTestResult(statusCode, hasPayload)
      const samplePatch = outcome.ok ? buildApiTestSuccessPatch(parsedBody, analysisModel) : buildApiTestSuccessPatch(null, null)
      commitApiTest(gen, {
        status: outcome.status,
        ok: outcome.ok,
        requestUrl: res.request.url,
        method: res.request.method,
        statusCode,
        responseHeaders: res.response?.headers ?? {},
        rawBody: res.response?.raw_body ?? null,
        parsedJson: parsedBody,
        rawResponse: parsedBody ?? res.response?.raw_body ?? null,
        ...samplePatch,
        startedAt,
        finishedAt: Date.now(),
        errorCode: outcome.ok ? null : 'http_error',
        errorType: outcome.ok ? null : 'http_error',
        errorMessage: outcome.ok
          ? null
          : statusCode != null && statusCode >= 400
            ? `HTTP ${statusCode} response — sample fetch did not succeed.`
            : 'No response payload returned.',
        targetStatusCode: outcome.ok ? null : statusCode,
        targetResponseBody: outcome.ok ? null : res.response?.raw_body ?? null,
        hint: outcome.ok ? null : 'Fix upstream errors or adjust the request, then retry API Test.',
        apiBacked: true,
        steps: mapApiSteps(res.steps),
        responseSample: parsedBody,
        effectiveHeadersMasked: res.request.headers_masked ?? null,
        actualRequestSent: res.actual_request_sent
          ? {
              method: res.actual_request_sent.method,
              url: res.actual_request_sent.url,
              endpoint: res.actual_request_sent.endpoint ?? null,
              queryParams: res.actual_request_sent.query_params ?? {},
              headersMasked: res.actual_request_sent.headers_masked ?? {},
              jsonBodyMasked: res.actual_request_sent.json_body_masked ?? null,
              timeoutSeconds: res.actual_request_sent.timeout_seconds,
            }
          : null,
        analysis: outcome.ok ? analysisModel : state.apiTest.analysis,
        s3ConnectivityPassed: false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'API test failed.'
      type ErrDetail = {
        error_type?: string
        error_code?: string
        message?: string
        target_status_code?: number
        target_response_body?: string
        hint?: string
        json_line?: number
        json_column?: number
        steps?: Array<{ name: string; success: boolean; status_code?: number | null; message?: string }>
        response_sample?: unknown
        effective_request?: { headers?: Record<string, string> }
      }
      let code: string | null = null
      let errorType: string | null = null
      let detail: string = message
      let targetStatusCode: number | null = null
      let targetResponseBody: string | null = null
      let hint: string | null = null
      let errSteps: WizardApiTestStep[] = []
      let responseSample: unknown = null
      let effectiveHeadersMasked: Record<string, string> | null = null
      let actualRequestSent: WizardApiTestState['actualRequestSent'] = null
      try {
        const parsed = JSON.parse(message) as { detail?: ErrDetail }
        const d = parsed.detail
        errorType = d?.error_type ?? null
        detail = d?.message ?? message
        if (d?.json_line != null) {
          detail = `${detail} (line ${d.json_line}${d.json_column != null ? `, column ${d.json_column}` : ''})`
        }
        targetStatusCode = d?.target_status_code ?? null
        targetResponseBody = d?.target_response_body ?? null
        hint = d?.hint ?? null
        code = d?.error_code ?? d?.error_type ?? errorType
        errSteps = mapApiSteps(d?.steps)
        responseSample = d?.response_sample ?? null
        effectiveHeadersMasked = d?.effective_request?.headers ?? null
        const req = (d as { actual_request_sent?: Record<string, unknown> } | undefined)?.actual_request_sent
        if (req && typeof req === 'object') {
          actualRequestSent = {
            method: String(req.method ?? 'GET'),
            url: String(req.url ?? ''),
            endpoint: req.endpoint == null ? null : String(req.endpoint),
            queryParams:
              req.query_params && typeof req.query_params === 'object' && !Array.isArray(req.query_params)
                ? (req.query_params as Record<string, unknown>)
                : {},
            headersMasked:
              req.headers_masked && typeof req.headers_masked === 'object' && !Array.isArray(req.headers_masked)
                ? Object.fromEntries(
                    Object.entries(req.headers_masked as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
                  )
                : {},
            jsonBodyMasked: req.json_body_masked ?? null,
            timeoutSeconds: Number(req.timeout_seconds ?? 0),
          }
        }
      } catch {
        /* leave defaults */
      }
      commitApiTest(gen, {
        status: 'error',
        ok: false,
        requestUrl: null,
        method: null,
        statusCode: null,
        responseHeaders: {},
        rawBody: null,
        parsedJson: null,
        rawResponse: null,
        extractedEvents: [],
        eventCount: 0,
        unionSchema: null,
        startedAt,
        finishedAt: Date.now(),
        errorCode: code,
        errorType,
        errorMessage: detail,
        targetStatusCode,
        targetResponseBody,
        hint,
        apiBacked: true,
        steps: errSteps,
        responseSample,
        effectiveHeadersMasked,
        actualRequestSent,
        analysis: null,
        s3ConnectivityPassed: false,
      })
    } finally {
      if (gen === requestGenRef.current) setBusy(false)
    }
  }, [busy, canRunLiveApiTest, commitApiTest, state])

  const t = state.apiTest
  const copy = sourcePres.wizardApiTest
  const elapsedMs = t.startedAt && t.finishedAt ? Math.max(0, t.finishedAt - t.startedAt) : null
  const showHttpTestContext = isHttp && (t.status === 'success' || t.status === 'error')
  const showWebhookContext = isWebhook && state.connector.connectorId != null && state.connector.sourceId != null
  const webhookReceiverUrl =
    state.connector.webhookReceiverPath && typeof window !== 'undefined'
      ? window.location.origin + state.connector.webhookReceiverPath
      : state.connector.webhookReceiverPath
  const webhookAuth = webhookAuthSummary(
    state.connector.webhookAuthMode,
    state.connector.webhookAuthHeaderName,
    state.connector.webhookSharedSecretConfigured,
    state.connector.webhookBearerTokenConfigured,
  )
  const testedRequest = t.actualRequestSent
  const testedMethod = testedRequest?.method ?? t.method ?? state.stream.httpMethod
  const testedUrl =
    testedRequest?.url ??
    t.requestUrl ??
    buildFullRequestUrl(state.connector.hostBaseUrl, state.stream.endpoint)
  const testedQueryEntries = testedRequest
    ? Object.entries(testedRequest.queryParams).map(([key, value]) => `${key}=${String(value)}`)
    : state.stream.params.filter((row) => row.key.trim()).map((row) => row.key.trim())
  const testedHeaderEntries = testedRequest
    ? Object.entries(testedRequest.headersMasked).map(([key, value]) => `${key}=${value}`)
    : []
  const testedBodyPreview = (() => {
    if (!testedRequest || testedRequest.jsonBodyMasked == null) return null
    try {
      const text = JSON.stringify(testedRequest.jsonBodyMasked, null, 2)
      return text.length > 1600 ? `${text.slice(0, 1600)}…` : text
    } catch {
      return '[masked body unavailable]'
    }
  })()
  const dbRows = isDatabase ? databaseSampleRows(t.parsedJson ?? t.rawResponse) : []
  const dbFieldTypes = databaseSampleFieldTypes(dbRows)
  const dbBoundParamCount = Object.keys(state.stream.dbQueryParams ?? {}).length
  const showDatabaseTestContext = isDatabase && (t.status === 'success' || t.status === 'error')
  const dbIncremental =
    state.stream.dbCheckpointMode.trim().toUpperCase() !== 'NONE' ||
    state.stream.dbCheckpointColumn.trim().length > 0

  return (
    <section
      className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid="wizard-run-test-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Run Test</h3>
          <p className="text-[12px] text-slate-600 dark:text-gdc-muted">{copy.leadParagraph}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || !canRunLiveApiTest}
            title={
              !canRunLiveApiTest
                ? `Select a ${WIZARD_LABEL.sourceConnection.toLowerCase()} and complete the required fields on the Stream Configuration step before running a live preview.`
                : undefined
            }
            className="inline-flex h-8 items-center gap-1 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
            {busy ? 'Running…' : 'Run Test'}
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || !canRunLiveApiTest}
            className="inline-flex h-8 items-center rounded-md border border-slate-200/90 bg-white px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
          >
            Retry
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {showWebhookContext ? (
          <div
            className="rounded-md border border-violet-200/80 bg-violet-500/[0.04] p-3 text-[11px] dark:border-violet-500/30 dark:bg-violet-500/10"
            data-testid="wizard-run-test-webhook-context"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-slate-800 dark:text-slate-100">Saved webhook receiver</p>
              <p className="text-slate-500 dark:text-gdc-mutedStrong">Secrets remain write-only and are never shown here.</p>
            </div>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Receiver URL</dt>
                <dd className="mt-0.5 break-all font-mono text-[10px] text-slate-800 dark:text-slate-200">
                  {webhookReceiverUrl || 'Generated after the receiver is saved'}
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Authorization</dt>
                <dd className="mt-0.5 text-slate-800 dark:text-slate-200">{webhookAuth}</dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Payload limit</dt>
                <dd className="mt-0.5 text-slate-800 dark:text-slate-200">{state.connector.webhookMaxRequestBytes.toLocaleString()} bytes</dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Preview source</dt>
                <dd className="mt-0.5 text-slate-800 dark:text-slate-200">
                  {state.connector.webhookPayloadPreview.trim() ? 'Saved synthetic payload' : 'Waiting for producer / no saved sample'}
                </dd>
              </div>
            </dl>
            {!state.connector.webhookPayloadPreview.trim() ? (
              <p
                className="mt-2 rounded border border-slate-200/80 bg-white/70 p-2 text-slate-600 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong"
                data-testid="wizard-webhook-waiting-state"
              >
                No producer event has to arrive during setup. Waiting is normal, not a connector failure. Save a representative payload preview when you want to validate fields before live traffic.
              </p>
            ) : null}
          </div>
        ) : null}
        {showDatabaseTestContext ? (
          <div
            className="rounded-md border border-sky-200/80 bg-sky-500/[0.04] p-3 text-[11px] dark:border-sky-500/30 dark:bg-sky-500/10"
            data-testid="wizard-run-test-database-context"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-slate-800 dark:text-slate-100">Actual database query preview</p>
              <p className="text-slate-500 dark:text-gdc-mutedStrong">
                {dbRows.length} returned row{dbRows.length === 1 ? '' : 's'} · preview cap 25 · {dbBoundParamCount} bound parameter{dbBoundParamCount === 1 ? '' : 's'}
              </p>
            </div>
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 bg-white p-2 font-mono text-[10px] text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200">
              {state.stream.sqlQuery.trim() || '(SQL query unavailable)'}
            </pre>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-slate-600 dark:text-gdc-mutedStrong">
              <span>
                <strong>Sync:</strong>{' '}
                {dbIncremental
                  ? `Incremental · checkpoint ${state.stream.dbCheckpointColumn.trim() || 'not selected'}`
                  : 'Full query each poll'}
              </span>
              <span><strong>Elapsed:</strong> {elapsedMs == null ? '—' : `${elapsedMs} ms`}</span>
            </div>
            <p className="mt-2 text-slate-600 dark:text-gdc-mutedStrong">
              Preview reads bounded rows only and does not advance the production checkpoint. Incremental sync must be confirmed against the latest sample in Record Selection before apply.
            </p>
            {dbFieldTypes.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Database sample field types">
                <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Sample field types:</span>
                {dbFieldTypes.map((field) => (
                  <code
                    key={field.name}
                    className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
                  >
                    {field.name} {field.type}
                  </code>
                ))}
              </div>
            ) : null}
            {dbRows.length > 0 ? (
              <div className="mt-2 overflow-auto rounded border border-slate-200 bg-white dark:border-gdc-border dark:bg-gdc-card">
                <table className="min-w-full border-collapse text-[10px]" data-testid="wizard-run-test-database-rows">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-gdc-border">
                      {dbFieldTypes.map((field) => (
                        <th key={field.name} className="px-2 py-1 text-left font-semibold text-slate-600 dark:text-gdc-mutedStrong">
                          {field.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dbRows.slice(0, 5).map((row, index) => (
                      <tr key={index} className="border-b border-slate-100 last:border-b-0 dark:border-gdc-border/60">
                        {dbFieldTypes.map((field) => (
                          <td key={field.name} className="max-w-56 break-words px-2 py-1 align-top font-mono text-slate-700 dark:text-slate-200">
                            {databaseCellDisplay(row[field.name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-slate-200 px-2 py-1 text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
                  Showing {Math.min(dbRows.length, 5)} of {dbRows.length} returned rows.
                </p>
              </div>
            ) : t.status === 'success' ? (
              <p className="mt-2 rounded border border-slate-200 bg-white p-2 text-slate-500 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted">
                Query succeeded with an empty bounded result. Review the filter, table contents, or sync position before apply.
              </p>
            ) : null}
          </div>
        ) : null}
        {showHttpTestContext ? (
          <div
            className="rounded-md border border-slate-200/80 bg-slate-50/70 p-3 text-[11px] dark:border-gdc-border dark:bg-gdc-card"
            data-testid="wizard-run-test-http-context"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-slate-800 dark:text-slate-100">
                {testedRequest ? 'Actual tested request' : 'Configured request context'}
              </p>
              <p className="text-slate-500 dark:text-gdc-mutedStrong">
                Authentication inherited from {state.connector.connectorName?.trim() || `Connector #${state.connector.connectorId ?? '—'}`}
              </p>
            </div>
            <p className="mt-2 break-all font-mono text-[11px] text-slate-800 dark:text-slate-100">
              <span className="font-bold">{testedMethod || '—'}</span> {testedUrl || '(request URL unavailable)'}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Tested query parameters">
              <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Query parameters:</span>
              {testedQueryEntries.length > 0 ? testedQueryEntries.map((entry) => (
                <code
                  key={entry}
                  className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200"
                >
                  {entry}
                </code>
              )) : <span className="text-slate-500 dark:text-gdc-muted">none</span>}
            </div>
            {testedRequest ? (
              <details
                className="mt-2 rounded-md border border-slate-200/80 bg-white/70 p-2 dark:border-gdc-border dark:bg-gdc-section"
                data-testid="wizard-run-test-http-request-details"
              >
                <summary className="cursor-pointer font-semibold text-slate-700 dark:text-slate-200">
                  Tested headers &amp; body · {testedHeaderEntries.length} header{testedHeaderEntries.length === 1 ? '' : 's'} · {testedBodyPreview == null ? 'no body' : 'body configured'}
                </summary>
                <div className="mt-2 space-y-2 text-[10px] text-slate-600 dark:text-gdc-mutedStrong">
                  <div>
                    <p className="font-semibold">Headers (masked)</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {testedHeaderEntries.length > 0 ? testedHeaderEntries.map((entry) => (
                        <code
                          key={entry}
                          className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 dark:border-gdc-border dark:bg-gdc-card"
                        >
                          {entry}
                        </code>
                      )) : <span>none</span>}
                    </div>
                  </div>
                  <div>
                    <p className="font-semibold">JSON body (masked)</p>
                    {testedBodyPreview == null ? (
                      <p className="mt-1">none</p>
                    ) : (
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[10px] text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200">
                        {testedBodyPreview}
                      </pre>
                    )}
                  </div>
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
        {t.status === 'idle' ? (
          <p className="rounded-md border border-slate-200 bg-slate-50 p-4 text-[12px] text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong">
            {canRunLiveApiTest
              ? copy.idleReady
              : `Select a ${WIZARD_LABEL.sourceConnection.toLowerCase()} first, then ${copy.idleBlockedTail}.`}
          </p>
        ) : null}
        {t.status === 'running' ? (
          <p className="rounded-md border border-slate-200 bg-slate-50 p-4 text-[12px] text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong">
            {isWebhook ? 'Validating the saved webhook payload preview…' : 'Calling source… this can take a few seconds depending on upstream latency.'}
          </p>
        ) : null}
        {t.status === 'error' ? (
          <ErrorPanel
            code={t.errorCode}
            errorType={t.errorType}
            message={t.errorMessage ?? 'Unknown error'}
            targetStatusCode={t.targetStatusCode ?? t.statusCode}
            hint={t.hint}
            failureStage={isHttp ? resolveHttpFailureStage(t.errorCode, t.errorType, t.targetStatusCode ?? t.statusCode) : null}
          />
        ) : null}
        {t.status === 'success' ? (
          <div className="space-y-3" data-testid="wizard-run-test-success">
            <SuccessPanel
              apiBacked={t.apiBacked}
              ok={t.ok}
              eventCount={t.eventCount}
              statusCode={t.statusCode}
              elapsedMs={elapsedMs}
              statusLabelOverride={isWebhook && t.eventCount === 0 ? 'Ready · waiting for event' : undefined}
            />
            {isWebhook && t.eventCount === 0 ? (
              <p className="rounded-md border border-violet-200/80 bg-violet-500/[0.04] p-3 text-[11px] text-slate-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-slate-200">
                The receiver is configured, but there is no sample to map yet. Add a saved synthetic payload or POST a limited test event to the receiver before Record Selection.
              </p>
            ) : null}
            {onAdvanceToRecordSelection && (!isWebhook || t.eventCount > 0) ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onAdvanceToRecordSelection}
                  data-testid="wizard-run-test-open-record-selection"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                >
                  Open Record Selection
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function SuccessPanel({
  apiBacked,
  ok,
  eventCount,
  statusCode,
  elapsedMs,
  statusLabelOverride,
}: {
  apiBacked: boolean
  ok: boolean
  eventCount: number
  statusCode: number | null
  elapsedMs: number | null
  statusLabelOverride?: string
}) {
  const statusLabel = statusLabelOverride ?? (ok
    ? apiBacked
      ? 'Success · API-backed'
      : 'Success · local preview'
    : 'Completed with warnings')
  const httpLabel = statusCode != null ? String(statusCode) : '—'

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="wizard-run-test-metrics">
      <Stat
        tone={ok ? 'success' : 'warning'}
        label="Status"
        value={statusLabel}
        icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
      />
      <Stat label="HTTP Status" value={httpLabel} />
      <Stat label="Records Detected" value={`${eventCount}`} />
      <Stat label="Latency" value={elapsedMs != null ? `${elapsedMs} ms` : '—'} />
    </div>
  )
}

function ErrorPanel({
  code,
  errorType,
  message,
  targetStatusCode,
  hint,
  failureStage,
}: {
  code: string | null
  errorType: string | null
  message: string
  targetStatusCode: number | null
  hint: string | null
  failureStage: HttpFailureStage | null
}) {
  return (
    <div className="space-y-3" data-testid="wizard-run-test-error">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat tone="warning" label="Status" value="Error" icon={<AlertCircle className="h-3.5 w-3.5" aria-hidden />} />
        <Stat label="HTTP Status" value={targetStatusCode != null ? String(targetStatusCode) : '—'} />
        <Stat label="Records Detected" value="0" />
        <Stat label="Latency" value="—" />
      </div>
      <div className="rounded-md border border-red-200/80 bg-red-500/[0.06] p-4 text-[12px] dark:border-red-500/40 dark:bg-red-500/10">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold text-red-800 dark:text-red-200">{code ?? 'API_TEST_FAILED'}</p>
            {failureStage ? (
              <p
                className="mt-1 text-[11px] font-semibold text-red-700 dark:text-red-200"
                data-testid="wizard-run-test-failure-stage"
              >
                Failure stage: {failureStage}
              </p>
            ) : null}
            <p className="mt-1 break-words text-red-700 dark:text-red-200">{message}</p>
            {errorType && errorType !== code ? (
              <p className="mt-2 text-[11px] text-red-700 dark:text-red-200">Type: {errorType}</p>
            ) : null}
            <p className="mt-2 text-[11px] text-red-600 dark:text-red-300/80">
              {hint ?? 'Check request URL, authentication, headers, and proxy settings.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string
  value: string
  tone?: 'success' | 'warning' | 'neutral'
  icon?: ReactNode
}) {
  const toneClass =
    tone === 'success'
      ? 'border-emerald-200/80 bg-emerald-500/[0.07] text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
      : tone === 'warning'
        ? 'border-amber-200/80 bg-amber-500/[0.07] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
        : 'border-slate-200/80 bg-slate-50/70 text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200'
  return (
    <div className={cn('rounded-md border p-3', toneClass)}>
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide opacity-80">
        {icon ?? null}
        {label}
      </p>
      <p className="mt-1 text-[12px] font-semibold">{value}</p>
    </div>
  )
}
