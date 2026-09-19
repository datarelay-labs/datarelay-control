import { useCallback, useEffect, useState } from 'react'
import { fetchAiProvidersList, validateAiProviderCredentials, type AiProviderRead } from '../../api/gdcAiProviders'
import { AiGatewayEmptyState, aiProvidersEmptyState } from './ai-gateway-empty-state'

export function AiProvidersPage() {
  const [rows, setRows] = useState<AiProviderRead[]>([])
  const [loading, setLoading] = useState(true)
  const [validatingId, setValidatingId] = useState<number | null>(null)
  const [validationMessage, setValidationMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await fetchAiProvidersList())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onValidate(providerId: number) {
    setValidatingId(providerId)
    setValidationMessage(null)
    try {
      const result = await validateAiProviderCredentials(providerId)
      setValidationMessage(`${result.status}: ${result.message}`)
    } catch (err) {
      setValidationMessage(err instanceof Error ? err.message : 'Validation failed')
    } finally {
      setValidatingId(null)
    }
  }

  const empty = aiProvidersEmptyState()

  return (
    <section data-testid="ai-providers-page" className="space-y-4">
      {validationMessage ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-gdc-border dark:bg-gdc-card">
          {validationMessage}
        </p>
      ) : null}
      {loading ? (
        <p className="text-sm text-slate-600 dark:text-gdc-muted">Loading providers…</p>
      ) : rows.length === 0 ? (
        <AiGatewayEmptyState testId="ai-providers-empty-state" {...empty} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-gdc-border">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-gdc-card dark:text-gdc-muted">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Endpoint</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-200 dark:border-gdc-border">
                  <td className="px-3 py-2 font-medium">{row.name}</td>
                  <td className="px-3 py-2">{row.provider_type}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.endpoint_url}</td>
                  <td className="px-3 py-2">{row.default_model ?? '—'}</td>
                  <td className="px-3 py-2">{row.enabled ? 'Enabled' : 'Disabled'}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="rounded-md bg-gdc-buttonPrimary px-2 py-1 text-xs text-white disabled:opacity-50"
                      disabled={validatingId === row.id}
                      onClick={() => void onValidate(row.id)}
                    >
                      {validatingId === row.id ? 'Validating…' : 'Validate credentials'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
