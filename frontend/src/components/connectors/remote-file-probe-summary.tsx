import type { ConnectorAuthTestResponse } from '../../api/gdcRuntimePreview'

export function RemoteFileProbeSummary({ res }: { res: ConnectorAuthTestResponse }) {
  const paths = res.sample_remote_paths?.length ? res.sample_remote_paths : []
  return (
    <div className="mb-2 w-full min-w-0 max-w-full rounded border border-slate-200 bg-white p-3 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
      <p className="mb-2 font-semibold text-slate-800 dark:text-slate-100">Remote file connectivity</p>
      <ul className="list-inside list-disc space-y-1 text-slate-700 dark:text-slate-200">
        <li>
          SSH reachable: <span className="font-mono">{String(res.ssh_reachable ?? false)}</span>
        </li>
        <li>
          Authentication: <span className="font-mono">{res.ssh_auth_ok == null ? 'not attempted' : String(res.ssh_auth_ok)}</span>
        </li>
        <li>
          Host key policy: <span className="font-mono">{String(res.host_key_status ?? '—')}</span>
        </li>
        <li>
          SFTP subsystem: <span className="font-mono">{res.sftp_available == null ? 'not attempted' : String(res.sftp_available)}</span>
        </li>
        <li>
          Remote directory accessible: <span className="font-mono">{String(res.remote_directory_accessible ?? false)}</span>
        </li>
        <li>
          Matched file count: <span className="font-mono">{String(res.matched_file_count ?? 0)}</span>
        </li>
      </ul>
      {paths.length > 0 ? (
        <div className="mt-2">
          <p className="font-semibold text-slate-800 dark:text-slate-100">Sample paths</p>
          <ul className="mt-1 list-inside list-decimal font-mono text-[10px] text-slate-600 dark:text-gdc-muted">
            {paths.map((k) => (
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

const SENSITIVE_KEY = /password|private_key|passphrase|secret|token|credential|authorization/i

/** Redact values for keys that may carry secrets before echoing probe JSON in the UI. */
export function redactConnectorAuthTestResponseForDisplay(res: ConnectorAuthTestResponse): Record<string, unknown> {
  const raw = res as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : v
  }
  return out
}
