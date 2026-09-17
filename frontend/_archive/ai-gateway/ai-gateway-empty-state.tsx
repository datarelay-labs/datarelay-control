import { Link } from 'react-router-dom'
import { NAV_PATH } from '../../config/nav-paths'

type AiGatewayEmptyStateProps = {
  title: string
  description: string
  primaryLabel: string
  primaryTo: string
  secondaryLabel?: string
  secondaryTo?: string
  tertiaryLabel?: string
  tertiaryTo?: string
  testId: string
}

export function AiGatewayEmptyState({
  title,
  description,
  primaryLabel,
  primaryTo,
  secondaryLabel,
  secondaryTo,
  tertiaryLabel,
  tertiaryTo,
  testId,
}: AiGatewayEmptyStateProps) {
  return (
    <section
      data-testid={testId}
      className="rounded-xl border border-green-200/80 bg-green-50/40 px-5 py-8 text-center dark:border-green-500/30 dark:bg-green-500/10"
    >
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] text-slate-600 dark:text-gdc-muted">{description}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link
          to={primaryTo}
          className="inline-flex items-center rounded-md bg-gdc-buttonPrimary px-3 py-1.5 text-xs font-semibold text-white hover:bg-gdc-buttonPrimaryHover"
        >
          {primaryLabel}
        </Link>
        {secondaryLabel && secondaryTo ? (
          <Link
            to={secondaryTo}
            className="inline-flex items-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
          >
            {secondaryLabel}
          </Link>
        ) : null}
        {tertiaryLabel && tertiaryTo ? (
          <Link
            to={tertiaryTo}
            className="inline-flex items-center rounded-md border border-dashed border-slate-300 bg-transparent px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-gdc-border dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
          >
            {tertiaryLabel}
          </Link>
        ) : null}
      </div>
    </section>
  )
}

export function aiStreamsEmptyState() {
  return {
    title: 'No AI streams yet',
    description: 'Create an AI stream to start routing model traffic.',
    primaryLabel: 'Create AI Stream',
    primaryTo: NAV_PATH.streams,
    secondaryLabel: 'Configure Provider',
    secondaryTo: NAV_PATH.aiGatewayProviders,
    tertiaryLabel: 'View setup guide',
    tertiaryTo: NAV_PATH.aiGatewayTraffic,
  }
}

export function aiProvidersEmptyState() {
  return {
    title: 'No AI providers yet',
    description: 'Register an OpenAI, Claude, Gemini, or compatible provider endpoint before routing AI traffic.',
    primaryLabel: 'Configure Provider',
    primaryTo: NAV_PATH.aiGatewayProviders,
    secondaryLabel: 'Create AI Stream',
    secondaryTo: NAV_PATH.streams,
    tertiaryLabel: 'View setup guide',
    tertiaryTo: NAV_PATH.aiGatewayTraffic,
  }
}

export function aiTrafficEmptyState() {
  return {
    title: 'No AI traffic recorded yet',
    description: 'After AI streams are enabled and receiving requests, traffic metrics appear here.',
    primaryLabel: 'Create AI Stream',
    primaryTo: NAV_PATH.streams,
    secondaryLabel: 'Configure Provider',
    secondaryTo: NAV_PATH.aiGatewayProviders,
    tertiaryLabel: 'View setup guide',
    tertiaryTo: NAV_PATH.aiGatewayStreams,
  }
}
