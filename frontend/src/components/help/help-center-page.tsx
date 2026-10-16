import { ArrowLeft, ArrowRight, BookOpen, CircleCheck, Compass } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { NAV_PATH, newStreamPath } from '../../config/nav-paths'

type GuideStep = { title: string; description: string; to: string; action: string }
type WorkflowGuide = {
  key: string
  title: string
  summary: string
  question: string
  steps: readonly GuideStep[]
  notice: string
}

const GUIDES: readonly WorkflowGuide[] = [
  {
    key: 'start',
    title: 'Set up your first stream',
    summary: 'Connect a source, choose its destinations, configure routes, and verify delivery.',
    question: 'How do I create a working data flow?',
    steps: [
      {
        title: 'Connect a source',
        description: 'Create a reusable Connector for the source product, or select one you already have. A Stream uses an existing Connector.',
        to: NAV_PATH.connectors, action: 'Open Connectors',
      },
      {
        title: 'Run a sample and select records',
        description: 'Start a Stream in the guided Wizard. Test source access, identify the event record path, and review checkpoint options before proceeding.',
        to: newStreamPath(), action: 'Create a Stream',
      },
      {
        title: 'Choose destinations',
        description: 'Create or select one or more reusable Destinations. Select them before editing destination-specific Route Processing.',
        to: NAV_PATH.destinations, action: 'Open Destinations',
      },
      {
        title: 'Configure Route Processing and deploy',
        description: 'Use Shared Processing for defaults, override a Route only where needed, then review readiness before creating or enabling the Stream.',
        to: newStreamPath(), action: 'Open Stream Wizard',
      },
      {
        title: 'Verify actual delivery',
        description: 'Open the created Stream in Streams, then inspect its Runtime delivery, route status, errors, and checkpoint. A preview alone is not proof.',
        to: NAV_PATH.streams, action: 'Open Streams',
      },
    ],
    notice: 'Source tests and draft previews do not prove that a running Stream delivered data. Confirm a real runtime outcome after deployment.',
  },
  {
    key: 'operations',
    title: 'Investigate data flow',
    summary: 'Go from Action needed to an affected Stream and the evidence behind its status.',
    question: 'What should I check when data stops arriving?',
    steps: [
      {
        title: 'Start with Action needed',
        description: 'The Dashboard prioritizes known unhealthy Streams, Routes, and Destinations. If the snapshot is unavailable, retry rather than assuming everything is healthy.',
        to: NAV_PATH.dashboard, action: 'Open Dashboard',
      },
      {
        title: 'Open the affected Stream',
        description: 'Use the Stream runtime view to inspect collection rate, route health, delivery results, and checkpoint state.',
        to: NAV_PATH.streams, action: 'Open Streams',
      },
      {
        title: 'Inspect delivery evidence',
        description: 'Use Logs to investigate a failed or missing delivery. Source sampling and Destination connection tests are not delivery confirmations.',
        to: NAV_PATH.logs, action: 'Open Logs',
      },
      {
        title: 'Review the owning configuration',
        description: 'If a Route is misconfigured, open Routes. If a receiver is unavailable, open Destinations. Change only the setting that explains the observed outcome.',
        to: NAV_PATH.routes, action: 'Open Routes',
      },
    ],
    notice: 'Runtime truth is authoritative. A green connection test, a successful preview, or an old cached metric does not establish a healthy delivery path.',
  },
  {
    key: 'delivery',
    title: 'Route delivery and previews',
    summary: 'Understand how one Stream feeds multiple Routes and how to verify each destination.',
    question: 'How do I confirm a Route sends the intended output?',
    steps: [
      {
        title: 'Review the delivery path',
        description: 'One Stream collects the event once. Each Route connects that Stream to a Destination and may apply destination-specific processing.',
        to: NAV_PATH.routes, action: 'View Routes',
      },
      {
        title: 'Configure the delivery endpoint',
        description: 'Destinations define reusable receiving endpoints. Review enabled state, configured capacity where available, and connectivity results.',
        to: NAV_PATH.destinations, action: 'Open Destinations',
      },
      {
        title: 'Compare Mapping and Enrichment',
        description: 'Use the Stream Wizard or Route editor to inspect available before/after events. Only stages with actual preview responses may show an output.',
        to: newStreamPath(), action: 'Open Stream Wizard',
      },
      {
        title: 'Verify saved and runtime behavior',
        description: 'A preview is not delivery. Check the saved Route, real runtime delivery outcomes, failure behavior, and checkpoint before claiming success.',
        to: NAV_PATH.streams, action: 'Open Streams',
      },
    ],
    notice: 'A preview is not delivery. UDP or best-effort sends may not provide a receiver acknowledgment; consult delivery logs and available downstream evidence.',
  },
  {
    key: 'governance',
    title: 'Governance investigations',
    summary: 'Find current protection issues and act from the workspace that owns them.',
    question: 'Where do I investigate a governance issue?',
    steps: [
      {
        title: 'Review Governance Dashboard',
        description: 'Start with current posture and prioritized investigations. The dashboard is for operations, not creating policies.',
        to: NAV_PATH.governance, action: 'Open Governance Dashboard',
      },
      {
        title: 'Investigate violations or held events',
        description: 'Open Violations or Quarantine to review supported evidence and authorized actions. Available functions depend on your role.',
        to: NAV_PATH.governanceViolations, action: 'Open Violations',
      },
      {
        title: 'Inspect audit and replay evidence',
        description: 'Use Audit and Replay for investigation and recovery, following the current operator permissions and confirmation steps.',
        to: NAV_PATH.governanceAudit, action: 'Open Audit',
      },
      {
        title: 'Return to policy ownership',
        description: 'Configure Stream defaults or destination-specific Route Processing from their owning configuration screens, not the operational dashboard.',
        to: NAV_PATH.routes, action: 'Open Routes',
      },
    ],
    notice: 'Governance requires suitable permissions. Viewing an investigation does not grant the right to change policy, release quarantine, or replay data.',
  },
  {
    key: 'administration',
    title: 'Platform administration',
    summary: 'Find access, network, retention, backup, and operational verification tasks.',
    question: 'Where should I make an administrative change?',
    steps: [
      {
        title: 'Access & security',
        description: 'Use Administration to find HTTPS settings, user access, and password management. Confirm roles and impact before making changes.',
        to: NAV_PATH.administration, action: 'Open Administration',
      },
      {
        title: 'Platform network',
        description: 'Review network listener and reverse-proxy settings. Some changes may require an explicit apply or service restart.',
        to: NAV_PATH.settings, action: 'Open Settings',
      },
      {
        title: 'Backup and lifecycle',
        description: 'Review backup/import and retention controls before mutating any persistent configuration. Test recoverability through approved procedures.',
        to: NAV_PATH.backup, action: 'Open Backup & Import',
      },
      {
        title: 'Review audit evidence',
        description: 'Inspect administrative and configuration changes using the existing audit views and roles.',
        to: NAV_PATH.administration, action: 'Open Administration',
      },
    ],
    notice: 'Administrative changes may affect access or persistent state. Read the displayed impact, use authorized roles, and avoid treating a successful form save as a verified runtime change.',
  },
]

function GuideDirectory() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6" data-testid="help-guide-directory">
      <header className="rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50 via-white to-white p-6 dark:border-gdc-border dark:from-gdc-panel dark:via-gdc-card dark:to-gdc-card md:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700 dark:text-violet-300">Operator guidance</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50 md:text-3xl">Help Center</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 dark:text-gdc-mutedStrong">
          Start from the task you are trying to complete. These guides use the same workspaces and permissions as the product.
        </p>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        {GUIDES.map((guide) => (
          <Link
            key={guide.key}
            to={`/help/${guide.key}`}
            className="group flex min-h-36 min-w-0 flex-col justify-between rounded-xl border border-slate-200/90 bg-white p-5 shadow-sm transition hover:border-violet-400 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-card"
          >
            <div>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{guide.title}</p>
              <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">{guide.summary}</p>
            </div>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-violet-700 dark:text-violet-300">
              Read guide <ArrowRight className="h-4 w-4" aria-hidden />
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}

export function HelpCenterPage() {
  const { topic } = useParams<{ topic?: string }>()
  if (!topic) return <GuideDirectory />
  const guide = GUIDES.find((item) => item.key === topic)
  if (!guide) {
    return (
      <section className="mx-auto w-full max-w-3xl space-y-4" data-testid="help-guide-unavailable">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">This guide is not available.</h1>
        <Link to="/help" className="inline-flex items-center gap-1 text-sm font-semibold text-violet-700 dark:text-violet-300">
          <ArrowLeft className="h-4 w-4" aria-hidden /> All guides
        </Link>
      </section>
    )
  }

  return (
    <article className="mx-auto w-full max-w-5xl space-y-5" data-testid="help-guide">
      <Link to="/help" className="inline-flex items-center gap-1.5 text-sm font-semibold text-violet-700 hover:underline dark:text-violet-300">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All guides
      </Link>
      <header className="rounded-2xl border border-slate-200/80 bg-white p-6 dark:border-gdc-border dark:bg-gdc-card md:p-8">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-violet-700 dark:text-violet-300">
          <BookOpen className="h-4 w-4" aria-hidden /> Step-by-step guide
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50 md:text-3xl">{guide.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-gdc-mutedStrong">{guide.summary}</p>
        <p className="mt-3 flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
          <Compass className="h-4 w-4 text-violet-700 dark:text-violet-300" aria-hidden /> {guide.question}
        </p>
      </header>
      <ol className="space-y-3" aria-label={`${guide.title} workflow`}>
        {guide.steps.map((step, index) => (
          <li key={step.title} className="flex min-w-0 gap-4 rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card md:p-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-sm font-bold tabular-nums text-violet-700 dark:text-violet-300">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{step.title}</h2>
              <p className="text-xs leading-6 text-slate-600 dark:text-gdc-mutedStrong">{step.description}</p>
              <Link to={step.to} className={cn('inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-violet-200 px-3 py-1.5 text-xs font-semibold text-violet-700 transition hover:bg-violet-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 dark:border-violet-500/30 dark:text-violet-300 dark:hover:bg-violet-500/10')}>
                {step.action} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
          </li>
        ))}
      </ol>
      <aside className="flex items-start gap-3 rounded-xl border border-slate-200/90 bg-slate-50 p-4 dark:border-gdc-border dark:bg-gdc-panel">
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-700 dark:text-violet-300" aria-hidden />
        <p className="text-xs leading-6 text-slate-700 dark:text-gdc-mutedStrong">{guide.notice}</p>
      </aside>
      <nav className="flex flex-wrap gap-3 border-t border-slate-200/80 pt-4 text-sm dark:border-gdc-border" aria-label="Related help">
        <Link to="/help" className="font-semibold text-violet-700 hover:underline dark:text-violet-300">Help Center</Link>
        <Link to={NAV_PATH.dashboard} className="font-medium text-slate-700 hover:underline dark:text-gdc-mutedStrong">Dashboard</Link>
      </nav>
    </article>
  )
}
