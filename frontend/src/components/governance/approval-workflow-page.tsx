import { CheckCircle2, ChevronDown, ClipboardCheck, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  activateGovernanceApproval,
  approveGovernancePolicy,
  separationOfDutiesKind,
  type SeparationOfDutiesKind,
  fetchGovernanceApprovalDetail,
  fetchGovernanceApprovals,
  rejectGovernancePolicy,
  submitGovernanceApproval,
  type ApprovalEventType,
  type ApprovalWindow,
  type GovernanceApprovalDetailResponse,
  type GovernanceApprovalQueueEntry,
  type PolicyStatus,
} from '../../api/gdcGovernanceApprovals'
import {
  canActivatePolicy,
  canApprovePolicy,
  canSubmitApproval,
  governanceAccessDeniedMessage,
  governanceReadOnlyReason,
} from '../../lib/governance-rbac'
import { getSessionUsername } from '../../auth/session'
import { cn } from '../../lib/utils'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'
import { GovernanceInvestigationDrawer } from './governance-investigation-drawer'
import { policyStatusBadgeClass, policyStatusLabel } from './policy-lifecycle'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'

const WINDOWS: readonly ApprovalWindow[] = ['24h', '7d', '30d'] as const
const POLICY_STATUSES: readonly PolicyStatus[] = ['DRAFT', 'REVIEW', 'ACTIVE', 'RETIRED'] as const
const APPROVAL_FILTER_SELECT =
  'block h-8 min-w-[92px] cursor-pointer appearance-none rounded-md border border-slate-300 bg-white py-1 pl-2.5 pr-8 text-[12px] font-medium text-slate-800 shadow-sm outline-none hover:border-slate-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/15 dark:border-gdc-borderStrong dark:bg-gdc-input dark:text-gdc-foreground dark:hover:border-slate-500 dark:focus:border-gdc-primary dark:focus:ring-gdc-primary/20'

function formatTime(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function approvalStatusBadgeClass(status: string) {
  switch (status) {
    case 'PENDING_REVIEW':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
    case 'APPROVED':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200'
    case 'REJECTED':
    case 'REQUEST_CHANGES':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
    case 'ACTIVATED':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  }
}

function eventTypeLabel(eventType: ApprovalEventType) {
  return eventType.replace(/_/g, ' ')
}

type SelfApprovalAction = 'approve' | 'activate'

/** F-187: true when the signed-in user is the one who submitted this policy for review. */
function submittedByCurrentUser(requester: string | null | undefined): boolean {
  const me = (getSessionUsername() ?? '').trim().toLowerCase()
  const who = (requester ?? '').trim().toLowerCase()
  return me !== '' && me === who
}

const SELF_APPROVAL_COPY: Record<SelfApprovalAction, { title: string; primaryLabel: string; verb: string }> = {
  approve: { title: 'Approve your own submission?', primaryLabel: 'Approve anyway', verb: 'approving' },
  activate: { title: 'Activate your own policy?', primaryLabel: 'Activate anyway', verb: 'activating' },
}

// F-187 fail-closed: the policy is in REVIEW but nobody is recorded as its submitter.
const SUBMITTER_UNKNOWN_COPY: Record<SelfApprovalAction, { title: string; primaryLabel: string; verb: string }> = {
  approve: { title: 'Approve without a recorded submitter?', primaryLabel: 'Approve anyway', verb: 'approving' },
  activate: { title: 'Activate without a recorded submitter?', primaryLabel: 'Activate anyway', verb: 'activating' },
}

function ApprovalReadOnlyBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      data-testid="approval-connector-banner"
      className="flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-500/[0.08] px-4 py-3 text-[12px] text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{message}</p>
    </div>
  )
}

function ApprovalDetailDrawer({
  detail,
  loading,
  actionLoading,
  readOnly,
  canApproveRole,
  canActivateRole,
  actionError,
  actionMessage,
  onClose,
  onSubmit,
  onApprove,
  onReject,
  onActivate,
}: {
  detail: GovernanceApprovalDetailResponse | null
  loading: boolean
  actionLoading: boolean
  readOnly: boolean
  canApproveRole: boolean
  canActivateRole: boolean
  actionError: string | null
  actionMessage: string | null
  onClose: () => void
  onSubmit: (comment: string) => void
  onApprove: (comment: string) => void
  onReject: (comment: string) => void
  onActivate: (comment: string) => void
}) {
  const [comment, setComment] = useState('')

  useEffect(() => {
    setComment('')
  }, [detail?.policy.id])

  if (!detail && !loading) return null

  const policy = detail?.policy
  const canSubmit = !readOnly && detail?.current_status === 'DRAFT'
  const canApprove = !readOnly && canApproveRole && detail?.current_status === 'REVIEW' && !detail.is_approved
  const canReject = !readOnly && canApproveRole && detail?.current_status === 'REVIEW'
  const canActivate = !readOnly && canActivateRole && detail?.current_status === 'REVIEW' && detail.is_approved
  // F-204: an approved policy waiting for activation must not look actionable to a role that cannot activate.
  const activationBlockedForRole = !readOnly && !canActivateRole && detail?.current_status === 'REVIEW' && detail.is_approved
  // F-187: the submitter may reject, but approving or activating needs an explicit confirmation.
  const selfSubmitted = submittedByCurrentUser(detail?.requester) && (canApprove || canActivate)
  const submitterUnknown = detail?.submitter_unknown === true && (canApprove || canActivate)

  return (
    <GovernanceInvestigationDrawer
      title="Policy approval"
      testId="approval-detail-drawer"
      closeTestId="approval-detail-close"
      loading={loading}
      hasContent={detail != null && policy != null}
      onClose={onClose}
      whatHappenedTestId="approval-section-what-happened"
      whyTestId="approval-section-why"
      whatShouldIDoTestId="approval-section-what-should-i-do"
      relatedTestId="approval-section-history"
      whatHappened={
        detail && policy ? (
          <div className="space-y-3">
            <div data-testid="approval-section-policy-summary">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{policy.name}</p>
              {policy.description ? (
                <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">{policy.description}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                <span className={cn('rounded px-2 py-0.5 font-medium', policyStatusBadgeClass(policy.status))}>
                  {policyStatusLabel(policy.status)}
                </span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  v{policy.version}
                </span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {policy.assigned_stream_count} stream{policy.assigned_stream_count === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <div data-testid="approval-section-review-context">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
                <div>
                  <dt className="text-slate-500">Approval status</dt>
                  <dd>
                    <span
                      className={cn(
                        'inline-block rounded px-2 py-0.5 font-medium',
                        approvalStatusBadgeClass(detail.approval_status),
                      )}
                    >
                      {detail.approval_status.replace(/_/g, ' ')}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Requester</dt>
                  <dd className="text-slate-900 dark:text-slate-100">{detail.requester ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Reviewer</dt>
                  <dd className="text-slate-900 dark:text-slate-100">{detail.reviewer ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Submitted</dt>
                  <dd className="text-slate-900 dark:text-slate-100">{formatTime(detail.submitted_at)}</dd>
                </div>
              </dl>
            </div>
          </div>
        ) : null
      }
      why={
        detail ? (
          <div className="space-y-2" data-testid="approval-section-impact">
            {detail.review_comment ? (
              <p className="rounded-md bg-slate-50 px-2 py-1.5 text-[12px] text-slate-700 dark:bg-gdc-rowHover dark:text-slate-200">
                {detail.review_comment}
              </p>
            ) : null}
            {detail.impact?.impact_data_available ? (
              <div className="space-y-1 text-[12px] text-slate-700 dark:text-gdc-muted">
                <p>
                  24h estimated impact:{' '}
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {detail.impact.impact_matched_events ?? 0} matched events
                  </span>
                </p>
                <p>Affected streams: {detail.impact.affected_stream_count}</p>
                {detail.simulation?.simulation_available && Object.keys(detail.simulation.action_breakdown).length ? (
                  <ul className="list-inside list-disc">
                    {Object.entries(detail.simulation.action_breakdown).map(([action, count]) => (
                      <li key={action}>
                        {action}: {count}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {detail.simulation?.dry_run_summary ? (
                  <p className="text-[11px] italic">{detail.simulation.dry_run_summary}</p>
                ) : null}
              </div>
            ) : (
              <p className="text-[12px] text-slate-500">No impact data available for this policy change.</p>
            )}
          </div>
        ) : null
      }
      related={
        detail ? (
          detail.history.length ? (
            <ol className="space-y-2">
              {detail.history.map((ev, idx) => (
                <li
                  key={`${ev.event_time}-${ev.event_type}-${idx}`}
                  className="rounded-md border border-slate-200/80 px-2 py-1.5 text-[12px] dark:border-gdc-border"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-900 dark:text-slate-100">{eventTypeLabel(ev.event_type)}</span>
                    <span className="text-[11px] text-slate-500">{formatTime(ev.event_time)}</span>
                  </div>
                  <p className="text-slate-600 dark:text-gdc-muted">{ev.actor}</p>
                  {ev.comment ? <p className="mt-0.5 text-slate-700 dark:text-slate-300">{ev.comment}</p> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[12px] text-slate-500">No approval events yet</p>
          )
        ) : null
      }
      whatShouldIDo={
        detail && !readOnly && (canSubmit || canApprove || canReject || canActivate || activationBlockedForRole || actionError || actionMessage) ? (
          <div className="space-y-2" data-testid="approval-section-actions">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Optional comment…"
              rows={2}
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-[12px] dark:border-gdc-border dark:bg-gdc-card"
              data-testid="approval-action-comment"
            />
            {selfSubmitted ? (
              <p data-testid="approval-self-approval-note" className="text-[12px] text-amber-800 dark:text-amber-200">
                You submitted this policy for review. Approving or activating it yourself needs an explicit
                confirmation and is recorded in the approval history; you can reject it without one.
              </p>
            ) : null}
            {submitterUnknown ? (
              <p data-testid="approval-submitter-unknown-note" className="text-[12px] text-amber-800 dark:text-amber-200">
                Nobody is recorded as the submitter of this review, so separation of duties cannot be checked.
                Approving or activating it needs an explicit confirmation that is recorded in the approval history;
                you can reject it without one.
              </p>
            ) : null}
            {activationBlockedForRole ? (
              <p data-testid="approval-activate-role-note" className="text-[12px] text-amber-800 dark:text-amber-200">
                This policy is approved and waiting for activation. Only a Governance Approver or Administrator can
                activate it.
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" data-testid="approval-action-error" className="text-[12px] font-medium text-red-700 dark:text-red-300">
                {actionError}
              </p>
            ) : null}
            {actionMessage ? (
              <p role="status" data-testid="approval-action-message" className="text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
                {actionMessage}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {canSubmit ? (
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => onSubmit(comment)}
                  data-testid="approval-action-submit"
                  className="rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  Submit for Review
                </button>
              ) : null}
              {canApprove ? (
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => onApprove(comment)}
                  data-testid="approval-action-approve"
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  Approve
                </button>
              ) : null}
              {canReject ? (
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => onReject(comment)}
                  data-testid="approval-action-reject"
                  className="rounded-md border border-red-300 px-3 py-1.5 text-[12px] font-semibold text-red-700 hover:bg-red-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-900/20 disabled:opacity-50"
                >
                  Reject
                </button>
              ) : null}
              {canActivate ? (
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => onActivate(comment)}
                  data-testid="approval-action-activate"
                  className="rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  Activate
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-slate-500">No actions available for your role on this approval.</p>
        )
      }
    />
  )
}

export function ApprovalWorkflowPage() {
  const canSubmit = canSubmitApproval()
  const canReview = canApprovePolicy()
  const canActivate = canActivatePolicy()
  const readOnly = !canSubmit && !canReview && !canActivate
  const readOnlyReason = governanceReadOnlyReason()
  const accessDenied = governanceAccessDeniedMessage('the policy approval queue')

  const [window, setWindow] = useState<ApprovalWindow>('24h')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [requesterFilter, setRequesterFilter] = useState('')
  const [reviewerFilter, setReviewerFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<GovernanceApprovalQueueEntry[]>([])
  const [selectedPolicyId, setSelectedPolicyId] = useState<number | null>(null)
  const [detail, setDetail] = useState<GovernanceApprovalDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [selfConfirm, setSelfConfirm] = useState<{ action: SelfApprovalAction; comment: string; kind: SeparationOfDutiesKind } | null>(null)

  const loadApprovals = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetchGovernanceApprovals({
        window,
        status: statusFilter || undefined,
        requester: requesterFilter || undefined,
        reviewer: reviewerFilter || undefined,
      })
      setApprovals(resp.approvals)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals')
      setApprovals([])
    } finally {
      setLoading(false)
    }
  }, [window, statusFilter, requesterFilter, reviewerFilter])

  useEffect(() => {
    void loadApprovals()
  }, [loadApprovals])

  const loadDetail = useCallback(async (policyId: number) => {
    setDetailLoading(true)
    try {
      const resp = await fetchGovernanceApprovalDetail(policyId)
      setDetail(resp)
    } catch {
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const openDrawer = useCallback(
    (policyId: number) => {
      setSelectedPolicyId(policyId)
      void loadDetail(policyId)
    },
    [loadDetail],
  )

  const closeDrawer = useCallback(() => {
    setSelectedPolicyId(null)
    setDetail(null)
    setActionError(null)
    setActionMessage(null)
    setSelfConfirm(null)
  }, [])

  const runAction = useCallback(
    async (
      fn: (id: number, comment: string) => Promise<unknown>,
      onSeparationOfDuties?: (kind: SeparationOfDutiesKind) => void,
    ) => {
      if (selectedPolicyId == null) return
      setActionLoading(true)
      setActionError(null)
      setActionMessage(null)
      try {
        const out = await fn(selectedPolicyId, '')
        const done = (out as { message?: string } | null)?.message
        setActionMessage(done || 'Approval action completed.')
        await loadApprovals()
        await loadDetail(selectedPolicyId)
      } catch (err) {
        const kind = onSeparationOfDuties ? separationOfDutiesKind(err) : null
        if (onSeparationOfDuties && kind) {
          // The server is authoritative about who submitted the policy (or that nobody is recorded):
          // offer the explicit override.
          onSeparationOfDuties(kind)
          return
        }
        setActionError(
          err instanceof Error && err.message
            ? `Action failed: ${err.message}`
            : 'Action failed. Your role may not be allowed to perform it.',
        )
      } finally {
        setActionLoading(false)
      }
    },
    [selectedPolicyId, loadApprovals, loadDetail],
  )

  // F-187: Approve and Activate are refused for the user who submitted the policy, and for a policy
  // whose submitter is not recorded, unless they explicitly confirm the override. The dialog is shown
  // up front when the session user is the requester or the detail reports an unknown submitter, and
  // also if the server reports either refusal.
  const requestGatedAction = useCallback(
    (action: SelfApprovalAction, comment: string) => {
      if (submittedByCurrentUser(detail?.requester)) {
        setSelfConfirm({ action, comment, kind: 'self' })
        return
      }
      if (detail?.submitter_unknown === true) {
        setSelfConfirm({ action, comment, kind: 'unknown' })
        return
      }
      const call = (id: number) =>
        action === 'approve' ? approveGovernancePolicy(id, comment) : activateGovernanceApproval(id, comment)
      void runAction(call, (kind) => setSelfConfirm({ action, comment, kind }))
    },
    [detail?.requester, detail?.submitter_unknown, runAction],
  )

  const confirmSelfApproval = useCallback(async () => {
    if (!selfConfirm) return
    const { action, comment } = selfConfirm
    setSelfConfirm(null)
    await runAction((id) =>
      action === 'approve'
        ? approveGovernancePolicy(id, comment, { allowSelfApproval: true })
        : activateGovernanceApproval(id, comment, { allowSelfApproval: true }),
    )
  }, [selfConfirm, runAction])

  const requesters = useMemo(() => {
    const set = new Set<string>()
    for (const row of approvals) {
      if (row.requester) set.add(row.requester)
    }
    return [...set].sort()
  }, [approvals])

  const reviewers = useMemo(() => {
    const set = new Set<string>()
    for (const row of approvals) {
      if (row.reviewer) set.add(row.reviewer)
    }
    return [...set].sort()
  }, [approvals])

  return (
    <div className="space-y-4" data-testid="approval-workflow-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Policy approvals</h2>
          </div>
          <p className="mt-1 max-w-2xl text-[13px] text-slate-600 dark:text-gdc-muted">
            Review policy changes before activation. What policy is changing, what is the impact, who reviewed it, and
            what can you do next?
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadApprovals()}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          data-testid="approval-refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </div>

      {readOnly && readOnlyReason ? <ApprovalReadOnlyBanner message={readOnlyReason} /> : null}

      <div
        className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200/80 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card"
        data-testid="approval-filters"
      >
        <label className="space-y-1 text-[11px]">
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">Time range</span>
          <span className="relative block">
            <select
              value={window}
              onChange={(e) => setWindow(e.target.value as ApprovalWindow)}
              className={APPROVAL_FILTER_SELECT}
              data-testid="approval-filter-window"
            >
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 dark:text-gdc-mutedStrong" aria-hidden />
          </span>
        </label>
        <label className="space-y-1 text-[11px]">
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">Status</span>
          <span className="relative block">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={APPROVAL_FILTER_SELECT}
              data-testid="approval-filter-status"
            >
              <option value="">All</option>
              {POLICY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value="PENDING_REVIEW">PENDING REVIEW</option>
              <option value="APPROVED">APPROVED</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 dark:text-gdc-mutedStrong" aria-hidden />
          </span>
        </label>
        <label className="space-y-1 text-[11px]">
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">Requester</span>
          <span className="relative block">
            <select
              value={requesterFilter}
              onChange={(e) => setRequesterFilter(e.target.value)}
              className={APPROVAL_FILTER_SELECT}
              data-testid="approval-filter-requester"
            >
              <option value="">All</option>
              {requesters.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 dark:text-gdc-mutedStrong" aria-hidden />
          </span>
        </label>
        <label className="space-y-1 text-[11px]">
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">Reviewer</span>
          <span className="relative block">
            <select
              value={reviewerFilter}
              onChange={(e) => setReviewerFilter(e.target.value)}
              className={APPROVAL_FILTER_SELECT}
              data-testid="approval-filter-reviewer"
            >
              <option value="">All</option>
              {reviewers.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 dark:text-gdc-mutedStrong" aria-hidden />
          </span>
        </label>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading approval queue…
        </div>
      ) : approvals.length === 0 ? (
        <div
          className="rounded-xl border border-dashed border-slate-300/80 bg-slate-50/50 p-8 text-center dark:border-gdc-border dark:bg-gdc-card/40"
          data-testid="approval-empty-state"
        >
          <CheckCircle2 className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
          {accessDenied ? (
            <>
              <p className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">Approval queue not available</p>
              <p className="mt-1 text-[13px] text-slate-600 dark:text-gdc-muted" data-testid="approval-access-denied">
                {accessDenied}
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">No policies in the approval queue</p>
              <p className="mt-1 text-[13px] text-slate-600 dark:text-gdc-muted">
                Submit a draft policy from Data Protection to start the review workflow.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200/80 dark:border-gdc-border" data-testid="approval-table">
          <table className={opTable}>
            <thead>
              <tr className={opThRow}>
                <th className={opTh}>Policy</th>
                <th className={opTh}>Status</th>
                <th className={opTh}>Requester</th>
                <th className={opTh}>Reviewer</th>
                <th className={opTh}>Submitted</th>
                <th className={opTh}>Risk / Impact</th>
                <th className={opTh}>Last action</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((row) => (
                <tr
                  key={row.policy_id}
                  className={cn(opTr, 'cursor-pointer hover:bg-slate-50 dark:hover:bg-gdc-rowHover')}
                  data-testid={`approval-row-${row.policy_id}`}
                  onClick={() => openDrawer(row.policy_id)}
                >
                  <td className={opTd}>
                    <span className="font-medium text-slate-900 dark:text-slate-100">{row.policy_name}</span>
                  </td>
                  <td className={opTd}>
                    <span
                      className={cn(
                        'rounded px-2 py-0.5 text-[11px] font-medium',
                        approvalStatusBadgeClass(row.approval_status),
                      )}
                    >
                      {row.approval_status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className={opTd}>{row.requester ?? '—'}</td>
                  <td className={opTd}>{row.reviewer ?? '—'}</td>
                  <td className={opTd}>{formatTime(row.submitted_at)}</td>
                  <td className={opTd}>{row.impact_label ?? '—'}</td>
                  <td className={opTd}>{row.last_action ? eventTypeLabel(row.last_action) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedPolicyId != null ? (
        <ApprovalDetailDrawer
          detail={detail}
          loading={detailLoading}
          actionLoading={actionLoading}
          readOnly={readOnly}
          canApproveRole={canReview}
          canActivateRole={canActivate}
          actionError={actionError}
          actionMessage={actionMessage}
          onClose={closeDrawer}
          onSubmit={(c) => void runAction((id, _) => submitGovernanceApproval(id, c))}
          onApprove={(c) => requestGatedAction('approve', c)}
          onReject={(c) => void runAction((id, _) => rejectGovernancePolicy(id, c))}
          onActivate={(c) => requestGatedAction('activate', c)}
        />
      ) : null}

      {selfConfirm ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open) setSelfConfirm(null)
          }}
          title={(selfConfirm.kind === 'unknown' ? SUBMITTER_UNKNOWN_COPY : SELF_APPROVAL_COPY)[selfConfirm.action].title}
          targetName={detail?.policy.name}
          impactBullets={[
            selfConfirm.kind === 'unknown'
              ? `Nobody is recorded as the submitter of this review, so separation of duties cannot be checked and ${SUBMITTER_UNKNOWN_COPY[selfConfirm.action].verb} it may skip an independent second review.`
              : `You submitted this policy for review, so ${SELF_APPROVAL_COPY[selfConfirm.action].verb} it yourself skips an independent second review.`,
            'The override is recorded in the approval history under your name.',
          ]}
          risk="high"
          primaryLabel={(selfConfirm.kind === 'unknown' ? SUBMITTER_UNKNOWN_COPY : SELF_APPROVAL_COPY)[selfConfirm.action].primaryLabel}
          onConfirm={confirmSelfApproval}
          busy={actionLoading}
          dataTestId={selfConfirm.kind === 'unknown' ? 'approval-submitter-unknown-dialog' : 'approval-self-approval-dialog'}
        />
      ) : null}
    </div>
  )
}
