import type { StreamRuntimeStatus } from '../api/streamRows'

/** Shared issue-rail context for console rows and runtime detail pages. */
export type StreamIssueContext = {
  id: string
  status: StreamRuntimeStatus
  connectorName: string
  connectorProductGroup?: string | null
  deliveryPctKnown: boolean
  deliveryPct: number
  routesError: number
  lastActivityRelative: string
  recentErrors: ReadonlyArray<{ message: string }>
}

export function issueWhatHappenedSummary(
  ctx: StreamIssueContext,
  headline?: StreamHeroHeadline,
): string {
  const h =
    headline ??
    deriveStreamHeroHeadline(ctx.status, ctx.routesError, ctx.deliveryPctKnown, ctx.deliveryPct)
  if (ctx.recentErrors[0]?.message) return ctx.recentErrors[0].message
  if (h === 'Stream Healthy') return 'Stream is operating normally with no active delivery issues.'
  if (h === 'Health Not Verified') return 'Delivery health has not been verified from runtime evidence.'
  if (h === 'Stream Idle') return 'Stream is idle; active delivery has not been confirmed.'
  if (h === 'Stream Stopped') return 'Stream is stopped — scheduled delivery is not running.'
  if (h === 'Delivery Failures Detected') return 'One or more delivery paths reported failures.'
  if (h === 'Delivery Delayed') return 'Delivery success rate or latency is below the healthy threshold.'
  if (h === 'Protection Violations Detected') return 'Data protection policies flagged events on this stream.'
  return `Stream status is ${ctx.status}.`
}

export function issueWhySummary(ctx: StreamIssueContext): string {
  const err = ctx.recentErrors[0]
  if (err?.message) return err.message
  if (ctx.status === 'ERROR') return 'Delivery failures or source errors were detected for this stream.'
  if (ctx.status === 'DEGRADED') return 'Delivery success rate or latency is below the healthy threshold.'
  if (ctx.routesError > 0) return `${ctx.routesError} delivery path${ctx.routesError === 1 ? '' : 's'} reporting errors.`
  if (ctx.status === 'STOPPED') return 'Stream is stopped; scheduled delivery is not running.'
  if (ctx.status === 'IDLE') return 'Stream is idle; delivery activity is not established.'
  if (ctx.status === 'UNKNOWN') return 'Stream runtime status is not verified.'
  if (!ctx.deliveryPctKnown) return 'Delivery outcomes not verified in loaded runtime evidence.'
  if (ctx.deliveryPct < 90) return `Delivery success rate ${ctx.deliveryPct.toFixed(1)}% is below 90%.`
  return 'No active issues in the loaded runtime evidence.'
}

export function issueChipLabel(ctx: StreamIssueContext): string {
  if (ctx.status === 'ERROR') return 'Failed'
  if (ctx.status === 'DEGRADED') return 'Degraded'
  if (ctx.routesError > 0) return 'Delivery path error'
  if (ctx.status === 'STOPPED') return 'Stopped'
  if (ctx.status === 'IDLE') return 'Idle'
  if (ctx.status === 'UNKNOWN') return 'Not verified'
  if (ctx.deliveryPctKnown && ctx.deliveryPct < 90) return 'Low success rate'
  if (!ctx.deliveryPctKnown) return 'Not verified'
  return 'Healthy'
}

export type StreamHeroHeadline =
  | 'Stream Healthy'
  | 'Delivery Delayed'
  | 'Delivery Failures Detected'
  | 'Stream Stopped'
  | 'Stream Idle'
  | 'Health Not Verified'
  | 'Protection Violations Detected'

export function deriveStreamHeroHeadline(
  status: StreamRuntimeStatus,
  routesError: number,
  deliveryPctKnown: boolean,
  deliveryPct: number,
  protectionViolations?: boolean,
): StreamHeroHeadline {
  if (protectionViolations) return 'Protection Violations Detected'
  if (status === 'STOPPED') return 'Stream Stopped'
  if (status === 'ERROR' || routesError > 0) return 'Delivery Failures Detected'
  if (status === 'DEGRADED' || (deliveryPctKnown && deliveryPct < 90)) return 'Delivery Delayed'
  if (status === 'IDLE') return 'Stream Idle'
  if (status === 'UNKNOWN' || !deliveryPctKnown) return 'Health Not Verified'
  return 'Stream Healthy'
}
