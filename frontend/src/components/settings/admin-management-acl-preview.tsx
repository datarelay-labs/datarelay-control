import { useState, type FormEvent } from 'react'
import { ShieldAlert } from 'lucide-react'
import {
  postAdminManagementAclPreview,
  type ManagementAccessPreviewDto,
} from '../../api/gdcAdmin'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'

function parseCidrs(raw: string): Array<{ cidr: string }> {
  return raw.split(/[\n,]+/).map((cidr) => cidr.trim()).filter(Boolean).map((cidr) => ({ cidr }))
}

/** Explicitly advisory. No Save, Apply, or host-policy mutation controls. */
export function AdminManagementAclPreview({ isAdministrator }: { isAdministrator: boolean }) {
  const [webEnabled, setWebEnabled] = useState(false)
  const [sshEnabled, setSshEnabled] = useState(false)
  const [webSources, setWebSources] = useState('')
  const [sshSources, setSshSources] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ManagementAccessPreviewDto | null>(null)

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isAdministrator || busy) return
    setError(null)
    setResult(null)
    setBusy(true)
    try {
      const data = await postAdminManagementAclPreview({
        web: { enabled: webEnabled, sources: parseCidrs(webSources) },
        ssh: { enabled: sshEnabled, sources: parseCidrs(sshSources) },
        rollback_seconds: 180,
      })
      // Ignore any future server-side claim of availability until the verified
      // host + UI/API enforcement adapter is independently qualified.
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to preview management access policy.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className={cn(gdcUi.cardShell, 'overflow-hidden')}
      aria-labelledby="admin-management-acl-heading"
      data-testid="admin-management-acl-preview"
    >
      <div className="flex gap-3 border-b border-slate-200 px-4 py-5 dark:border-gdc-border md:px-6">
        <ShieldAlert className="h-6 w-6 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
        <div>
          <h3 id="admin-management-acl-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
            Management access IP allowlist
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
            <strong>Preview only — not enforced.</strong> SSH host controls, Web UI and management API ingress
            enforcement, emergency-console recovery, and automatic rollback are not yet available.
          </p>
        </div>
      </div>

      <form className="space-y-4 px-4 py-5 text-sm dark:text-slate-200 md:px-6" onSubmit={(e) => void preview(e)}>
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/20 dark:text-amber-100">
          No access restrictions are active from this preview. Proposed ranges are neither saved nor applied.
          If you need enforcement, a verified emergency console and host rollback integration are required.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="flex items-center gap-2 font-semibold">
              <input type="checkbox" checked={webEnabled} disabled={!isAdministrator || busy}
                onChange={(e) => { setWebEnabled(e.target.checked); setResult(null) }} />
              Evaluate a restricted Web/UI + API policy (draft)
            </label>
            <label htmlFor="management-web-cidrs" className="block text-slate-700 dark:text-slate-200">
              Proposed Web/UI + API source IPs or CIDRs
            </label>
            <textarea id="management-web-cidrs" rows={3} value={webSources}
              disabled={!isAdministrator || busy}
              placeholder="192.0.2.0/24, 2001:db8::/64"
              className={cn(gdcUi.input, 'w-full font-mono text-sm')}
              onChange={(e) => { setWebSources(e.target.value); setResult(null) }}
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 font-semibold">
              <input type="checkbox" checked={sshEnabled} disabled={!isAdministrator || busy}
                onChange={(e) => { setSshEnabled(e.target.checked); setResult(null) }} />
              Evaluate a restricted host SSH policy (draft)
            </label>
            <label htmlFor="management-ssh-cidrs" className="block text-slate-700 dark:text-slate-200">
              Proposed host SSH source IPs or CIDRs
            </label>
            <textarea id="management-ssh-cidrs" rows={3} value={sshSources}
              disabled={!isAdministrator || busy}
              placeholder="198.51.100.14/32"
              className={cn(gdcUi.input, 'w-full font-mono text-sm')}
              onChange={(e) => { setSshSources(e.target.value); setResult(null) }}
            />
          </div>
        </div>

        {error ? <p role="alert" className="text-rose-700 dark:text-rose-300">{error}</p> : null}

        {result ? (
          <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-gdc-border dark:bg-gdc-section" data-testid="management-acl-preview-result">
            <p className="font-semibold">Proposal diagnostics — no live policy change</p>
            <p>Observed API peer: {result.observed_api_source ?? 'Unknown (not the verified public client)'}</p>
            <p>Web source check: {result.web_reason} ({result.web_source_matches ? 'match' : 'not matched'})</p>
            <p>SSH source check: {result.ssh_reason}</p>
            <p className="font-semibold">Enforcement: Unavailable for SSH and Web UI/API</p>
            <ul className="list-disc space-y-1 pl-5">
              {result.blockers.map((blocker) => <li key={blocker}>{blocker.replaceAll('_', ' ')}</li>)}
            </ul>
          </div>
        ) : null}

        <div className="flex justify-end">
          <button type="submit" disabled={!isAdministrator || busy}
            className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-800 disabled:opacity-50 dark:border-gdc-border dark:text-slate-100">
            {busy ? 'Checking proposal…' : 'Preview proposal only'}
          </button>
        </div>
        {!isAdministrator ? <p role="status">Only an Administrator may preview management access proposals.</p> : null}
      </form>
    </section>
  )
}
