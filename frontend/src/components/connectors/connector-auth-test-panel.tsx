import { useCallback, useState } from 'react'
import {
  runConnectorAuthTest,
  type ConnectorAuthTestRequestPayload,
  type ConnectorAuthTestResponse,
} from '../../api/gdcRuntimePreview'
import { redactConnectorAuthTestResponseForDisplay, RemoteFileProbeSummary } from './remote-file-probe-summary'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type AuthTestHttpMethod = (typeof METHODS)[number]

function S3ProbeSummary({ res }: { res: ConnectorAuthTestResponse }) {
  const keys = res.s3_sample_keys?.length ? res.s3_sample_keys : []
  return (
    <div className="mb-2 w-full min-w-0 max-w-full rounded border border-slate-200 bg-white p-3 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
      <p className="mb-2 font-semibold text-slate-800 dark:text-slate-100">S3 probe summary</p>
      <ul className="list-inside list-disc space-y-1 text-slate-700 dark:text-slate-200">
        <li>
          Endpoint reachable: <span className="font-mono">{String(res.s3_endpoint_reachable ?? false)}</span>
        </li>
        <li>
          Auth / HeadBucket:{' '}
          <span className="font-mono">
            {String(res.s3_auth_ok ?? false)} (credentials accepted for bucket access checks)
          </span>
        </li>
        <li>
          Bucket exists: <span className="font-mono">{String(res.s3_bucket_exists ?? false)}</span>
        </li>
        <li>
          Object count preview (capped): <span className="font-mono">{String(res.s3_object_count_preview ?? 0)}</span>
        </li>
      </ul>
      {keys.length > 0 ? (
        <div className="mt-2">
          <p className="font-semibold text-slate-800 dark:text-slate-100">Sample object keys</p>
          <ul className="mt-1 list-inside list-decimal font-mono text-[10px] text-slate-600 dark:text-gdc-muted">
            {keys.map((k) => (
              <li key={k} className="break-all">
                {k}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {res.message ? (
        <p className="mt-2 text-slate-600 dark:text-gdc-muted">
          <span className="font-semibold">Message: </span>
          {res.message}
        </p>
      ) : null}
      {res.error_type ? (
        <p className="mt-1 text-red-700 dark:text-red-300">
          <span className="font-semibold">Error type: </span>
          {res.error_type}
        </p>
      ) : null}
    </div>
  )
}

export type ConnectorAuthTestPanelProps = {
  /** Build API payload (connector_id XOR inline_flat_source) plus shared test fields are merged in panel. */
  buildAuthTestPayload: (ctx: { method: AuthTestHttpMethod; testPath: string; jsonBody: unknown | undefined }) => ConnectorAuthTestRequestPayload
  /** Optional: clear parent error banner when starting a test */
  onTestStart?: () => void
  /** HTTP probe vs S3 vs database vs remote file connectivity. */
  mode?: 'http' | 's3' | 'database' | 'remote_file'
}

export function ConnectorAuthTestPanel({ buildAuthTestPayload, onTestStart, mode = 'http' }: ConnectorAuthTestPanelProps) {
  const [authTestMethod, setAuthTestMethod] = useState<AuthTestHttpMethod>('GET')
  const [authTestPath, setAuthTestPath] = useState('/')
  const [authTestBody, setAuthTestBody] = useState('')
  const [rfDir, setRfDir] = useState('')
  const [rfPattern, setRfPattern] = useState('*')
  const [rfRecursive, setRfRecursive] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
  const [authDetail, setAuthDetail] = useState<string | null>(null)

  const onTestAuthentication = useCallback(async () => {
    onTestStart?.()
    setAuthBusy(true)
    setAuthDetail(null)
    let jsonBody: unknown | undefined
    if (authTestMethod !== 'GET') {
      const raw = authTestBody.trim()
      if (raw) {
        try {
          jsonBody = JSON.parse(raw) as unknown
        } catch {
          setAuthDetail('Invalid JSON syntax in Auth Test body. Fix it before running the test.')
          setAuthBusy(false)
          return
        }
      }
    }
    let payload: ConnectorAuthTestRequestPayload
    try {
      payload = buildAuthTestPayload({
        method: authTestMethod,
        testPath: authTestPath.trim() || '/',
        jsonBody,
      })
      if (mode === 'remote_file') {
        payload = {
          ...payload,
          remote_file_stream_config: {
            remote_directory: rfDir.trim(),
            file_pattern: (rfPattern.trim() || '*') as string,
            recursive: rfRecursive,
          },
        }
        if (!rfDir.trim()) {
          setAuthDetail('Remote directory is required for the remote file connectivity test.')
          setAuthBusy(false)
          return
        }
      }
    } catch (err) {
      setAuthDetail(err instanceof Error ? err.message : String(err))
      setAuthBusy(false)
      return
    }
    try {
      const res = await runConnectorAuthTest(payload)
      setAuthDetail(JSON.stringify(redactConnectorAuthTestResponseForDisplay(res), null, 2))
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      try {
        const parsed = JSON.parse(raw) as ConnectorAuthTestResponse
        setAuthDetail(JSON.stringify(redactConnectorAuthTestResponseForDisplay(parsed), null, 2))
      } catch {
        setAuthDetail(raw)
      }
    } finally {
      setAuthBusy(false)
    }
  }, [authTestBody, authTestMethod, authTestPath, buildAuthTestPayload, mode, onTestStart, rfDir, rfPattern, rfRecursive])

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-4">
      <section className="w-full min-w-0 shrink-0 rounded-lg border border-slate-200 p-4 dark:border-gdc-border">
        <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-50">
          {mode === 's3'
            ? 'S3 connectivity test'
            : mode === 'database'
              ? 'Database connectivity test'
              : mode === 'remote_file'
                ? 'Remote file connectivity test'
                : 'Auth Test Request'}
        </h3>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500 dark:text-gdc-muted">
          {mode === 's3' ? (
            <>
              Runs a non-destructive S3 probe (HeadBucket + capped ListObjects). Response JSON includes bucket existence, object count preview, and sample keys — never secret material or signed URLs.
            </>
          ) : mode === 'database' ? (
            <>
              Runs <span className="font-semibold">SELECT 1</span> against the configured database using the same driver stack as runtime. Passwords are never echoed in responses.
            </>
          ) : mode === 'remote_file' ? (
            <>
              Verifies SSH reachability, authentication, SFTP availability, and that the configured directory can be listed. Enter the same <span className="font-semibold">remote_directory</span> and{' '}
              <span className="font-semibold">file_pattern</span> you use on the stream. Passwords and keys are never returned in responses.
            </>
          ) : (
            <>
              Many APIs return <span className="font-semibold">404</span> or <span className="font-semibold">405</span> on the root URL. Test against a real API path (e.g. Stellar Cyber{' '}
              <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">/connect/api/v1/alerts</code>). The response below always includes HTTP status and body — including 404/405 — plus masked headers.
            </>
          )}
        </p>
        <div className="grid w-full min-w-0 gap-3 md:grid-cols-2">
          <label className="block min-w-0 text-[12px] font-medium text-slate-700 dark:text-slate-200">
            Method
            <select
              value={authTestMethod}
              disabled={mode === 's3' || mode === 'database' || mode === 'remote_file'}
              onChange={(e) => setAuthTestMethod(e.target.value as AuthTestHttpMethod)}
              className="mt-1 h-9 w-full rounded border border-slate-200 bg-white px-2 text-sm dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0 text-[12px] font-medium text-slate-700 dark:text-slate-200">
            Test path
            <input
              value={authTestPath}
              disabled={mode === 's3' || mode === 'database' || mode === 'remote_file'}
              onChange={(e) => setAuthTestPath(e.target.value)}
              placeholder="/connect/api/v1/alerts"
              className="mt-1 h-9 w-full rounded border border-slate-200 bg-white px-2 font-mono text-sm dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
        </div>
        {mode === 'remote_file' ? (
          <div className="mt-3 grid w-full min-w-0 gap-3 md:grid-cols-2">
            <label className="block text-[12px] font-medium text-slate-700 dark:text-slate-200 md:col-span-2">
              Remote directory *
              <input
                value={rfDir}
                onChange={(e) => setRfDir(e.target.value)}
                placeholder="/var/log or upload"
                className="mt-1 h-9 w-full rounded border border-slate-200 bg-white px-2 font-mono text-sm dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
              />
            </label>
            <label className="block text-[12px] font-medium text-slate-700 dark:text-slate-200">
              File pattern
              <input
                value={rfPattern}
                onChange={(e) => setRfPattern(e.target.value)}
                placeholder="*.ndjson"
                className="mt-1 h-9 w-full rounded border border-slate-200 bg-white px-2 font-mono text-sm dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
              />
            </label>
            <label className="mt-6 flex items-center gap-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
              <input type="checkbox" checked={rfRecursive} onChange={(e) => setRfRecursive(e.target.checked)} />
              Recursive directory scan
            </label>
          </div>
        ) : null}
        {authTestMethod !== 'GET' && mode !== 'remote_file' ? (
          <label className="mt-3 block text-[12px] font-medium text-slate-700 dark:text-slate-200">
            JSON body (optional)
            <textarea
              value={authTestBody}
              onChange={(e) => setAuthTestBody(e.target.value)}
              rows={4}
              placeholder="{}"
              className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            />
          </label>
        ) : null}
        <div className="mt-4">
          <button
            type="button"
            disabled={authBusy}
            onClick={() => void onTestAuthentication()}
            className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-borderStrong dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
          >
            {authBusy
              ? 'Testing…'
              : mode === 's3'
                ? 'Test S3 connectivity'
                : mode === 'database'
                  ? 'Test database connectivity'
                  : mode === 'remote_file'
                    ? 'Test remote file connectivity'
                    : 'Test Authentication'}
          </button>
        </div>
      </section>

      {authDetail ? (
        <div className="w-full min-w-0 max-w-full space-y-2">
          {(() => {
            try {
              const parsed = JSON.parse(authDetail) as ConnectorAuthTestResponse & {
                success?: boolean
                ok?: boolean
                status_code?: number
                http_status?: number
                message?: string
                error?: string
                error_type?: string
              }
              if (typeof parsed !== 'object' || parsed === null) return null
              const statusCode = parsed.status_code ?? parsed.http_status ?? null
              const success =
                parsed.success === true ||
                parsed.ok === true ||
                (typeof statusCode === 'number' && statusCode >= 200 && statusCode < 400 && parsed.success !== false)
              const reason =
                parsed.message ||
                parsed.error ||
                parsed.error_type ||
                (typeof statusCode === 'number' ? `HTTP ${statusCode}` : null)
              return (
                <div
                  data-testid="auth-test-result-banner"
                  className={
                    success
                      ? 'rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12px] font-semibold text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-100'
                      : 'rounded border border-red-300 bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-900 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-100'
                  }
                >
                  {success ? 'Authentication success' : 'Authentication failure'}
                  {reason ? <span className="mt-0.5 block font-normal opacity-90">{reason}</span> : null}
                </div>
              )
            } catch {
              const looksFail = /fail|error|401|403|unauthor|denied|invalid/i.test(authDetail)
              return (
                <div
                  data-testid="auth-test-result-banner"
                  className={
                    looksFail
                      ? 'rounded border border-red-300 bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-900 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-100'
                      : 'rounded border border-slate-300 bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'
                  }
                >
                  {looksFail ? 'Authentication failure' : 'Authentication result'}
                </div>
              )
            }
          })()}
          {mode === 'remote_file'
            ? (() => {
                try {
                  const parsed = JSON.parse(authDetail) as ConnectorAuthTestResponse
                  if (typeof parsed === 'object' && parsed !== null && 'ssh_reachable' in parsed) {
                    return <RemoteFileProbeSummary res={parsed} />
                  }
                } catch {
                  /* fall through */
                }
                return null
              })()
            : null}
          {mode === 's3'
            ? (() => {
                try {
                  const parsed = JSON.parse(authDetail) as ConnectorAuthTestResponse
                  if (typeof parsed === 'object' && parsed !== null && 's3_endpoint_reachable' in parsed) {
                    return <S3ProbeSummary res={parsed} />
                  }
                } catch {
                  /* fall through to raw */
                }
                return null
              })()
            : null}
          <pre
            data-testid="auth-test-result-detail"
            className="w-full min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          >
            {authDetail}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
