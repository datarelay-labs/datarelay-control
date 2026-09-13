import { Loader2, Plus, RefreshCw, Shield, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  deleteGovernancePolicy,
  fetchGovernancePolicies,
  type GovernancePolicyEntry,
} from '../../api/gdcGovernancePolicies'
import { canEditPolicy } from '../../lib/governance-rbac'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { PolicyEditorDrawer } from './policy-editor-drawer'
import { policyCanDelete, policyStatusBadgeClass, policyStatusLabel } from './policy-lifecycle'
import { PolicyRuntimeNotice } from './policy-runtime-notice'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', policyStatusBadgeClass(status))}
      data-testid={`policy-status-badge-${status}`}
    >
      {policyStatusLabel(status)}
    </span>
  )
}

function categoryLabel(category: string) {
  return category.replace(/_/g, ' ')
}

export function PolicyCatalogPage() {
  const canEdit = canEditPolicy()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [policies, setPolicies] = useState<GovernancePolicyEntry[]>([])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingPolicy, setEditingPolicy] = useState<GovernancePolicyEntry | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deleteDialogPolicy, setDeleteDialogPolicy] = useState<GovernancePolicyEntry | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchGovernancePolicies()
      setPolicies(data?.policies ?? [])
      if (data == null) setError('Governance policy APIs unavailable.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    if (!canEdit) return
    setEditingPolicy(null)
    setEditorOpen(true)
  }

  const openEdit = (policy: GovernancePolicyEntry) => {
    setEditingPolicy(policy)
    setEditorOpen(true)
  }

  const executeDelete = async (policy: GovernancePolicyEntry) => {
    if (!canEdit) return
    setDeletingId(policy.id)
    try {
      const ok = await deleteGovernancePolicy(policy.id)
      if (!ok) throw new Error('Delete failed.')
      setDeleteDialogPolicy(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-4" data-testid="policy-catalog-page">
      <section className="rounded-xl border border-slate-200/90 bg-white p-4 dark:border-gdc-border dark:bg-gdc-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="inline-flex items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-slate-100">
              <Shield className="h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
              Data Protection
            </p>
            <p className="mt-1 text-[12px] text-slate-500 dark:text-gdc-muted">
              Manage named policies and see which streams they protect.
              {!canEdit ? ' Read-only — policy edits require Governance Operator role.' : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => void load()}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200/90 px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
              Refresh
            </button>
            {canEdit ? (
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-violet-600 px-2.5 text-[11px] font-semibold text-white hover:bg-violet-700 dark:bg-violet-500"
                data-testid="policy-catalog-new"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                New Policy
              </button>
            ) : null}
          </div>
        </div>

        <PolicyRuntimeNotice className="mt-3" />

        {error ? (
          <p className="mt-2 text-[11px] text-red-700 dark:text-red-300" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section
        className="rounded-xl border border-slate-200/90 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card"
        aria-label="Policy catalog"
      >
        <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Policy Catalog</p>
        <div className="mt-2 overflow-x-auto">
          <table className={opTable} data-testid="policy-catalog-table">
            <thead>
              <tr className={opThRow}>
                <th className={opTh}>Name</th>
                <th className={opTh}>Category</th>
                <th className={opTh}>Status</th>
                <th className={opTh}>Version</th>
                <th className={opTh}>Impact (24h)</th>
                <th className={opTh}>Assigned Streams</th>
                <th className={opTh}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id} className={opTr}>
                  <td className={opTd}>
                    <button
                      type="button"
                      onClick={() => openEdit(policy)}
                      className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
                      data-testid={`policy-catalog-row-${policy.id}`}
                    >
                      {policy.name}
                    </button>
                  </td>
                  <td className={opTd}>{categoryLabel(policy.category)}</td>
                  <td className={opTd}>
                    <StatusBadge status={policy.status} />
                  </td>
                  <td className={cn(opTd, 'tabular-nums')}>v{policy.version}</td>
                  <td className={opTd}>
                    {policy.impact_data_available && policy.impact_summary ? (
                      <span className="text-[11px] text-slate-700 dark:text-slate-200">
                        Impact: {policy.impact_summary}
                      </span>
                    ) : (
                      <span className="text-[11px] text-slate-400 dark:text-gdc-muted">—</span>
                    )}
                  </td>
                  <td className={cn(opTd, 'tabular-nums')}>{policy.assigned_stream_count}</td>
                  <td className={opTd}>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(policy)}
                        className="rounded border border-slate-200/90 px-2 py-0.5 text-[10px] font-semibold dark:border-gdc-border"
                        data-testid={`policy-catalog-view-${policy.id}`}
                      >
                        {canEdit ? 'Edit' : 'View'}
                      </button>
                      {canEdit && policyCanDelete(policy.status) ? (
                        <button
                          type="button"
                          disabled={deletingId === policy.id}
                          onClick={() => setDeleteDialogPolicy(policy)}
                          className="inline-flex items-center gap-0.5 rounded border border-red-200/90 px-2 py-0.5 text-[10px] font-semibold text-red-700 disabled:opacity-50 dark:border-red-500/30 dark:text-red-300"
                          data-testid={`policy-catalog-delete-${policy.id}`}
                        >
                          {deletingId === policy.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                          ) : (
                            <Trash2 className="h-3 w-3" aria-hidden />
                          )}
                          Delete
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {policies.length === 0 && !loading ? (
                <tr className={opTr}>
                  <td className={opTd} colSpan={7}>
                    No policies yet. Create a named policy to get started.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <PolicyEditorDrawer
        open={editorOpen}
        policy={editingPolicy}
        readOnly={!canEdit}
        onClose={() => setEditorOpen(false)}
        onSaved={() => void load()}
      />
      {deleteDialogPolicy ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open && deletingId == null) setDeleteDialogPolicy(null)
          }}
          title="Delete policy permanently?"
          targetName={deleteDialogPolicy.name}
          impactBullets={[
            'Removes the retired policy definition from the catalog.',
            'Stream assignments for this policy are removed with it.',
          ]}
          dependencies={
            deleteDialogPolicy.assigned_stream_count > 0
              ? [{ label: 'Assigned streams', count: deleteDialogPolicy.assigned_stream_count }]
              : []
          }
          reversibility="Delete is permanent. Retire instead if you may need the policy again."
          primaryLabel="Delete policy"
          busy={deletingId === deleteDialogPolicy.id}
          onConfirm={() => void executeDelete(deleteDialogPolicy)}
          dataTestId="policy-delete-dialog"
        />
      ) : null}
    </div>
  )
}
