import { ChevronDown, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { saveStreamMappingUiConfigStrict } from '../../api/gdcRuntimeUi'
import {
  buildFieldMappingsWithTransformRules,
  extractPreservedFieldMappingMetadata,
  parseTransformRulesFromFieldMappings,
} from '../../utils/advancedTransformConfig'
import { rowsFromFieldMappings } from '../../utils/mappingFieldMappings'
import { fieldMappingsFromRows } from '../../utils/mappingValidation'
import { loadMappingWorkspaceContext } from '../../utils/mappingSourceSample'
import type { AdvancedTransformRuleDraft } from '../../types/advancedTransform'
import { StatusBadge } from '../shell/status-badge'
import type { MappingRowModel } from '../streams/stream-mapping-model'
import { MappingWorkspace } from './mapping-workspace'

type MappingMeta = {
  connector: string
  stream: string
  sourceType: string
  status: 'ACTIVE' | 'INACTIVE'
  updatedAt: string
}

const EMPTY_META: MappingMeta = {
  connector: '—',
  stream: '—',
  sourceType: '—',
  status: 'INACTIVE',
  updatedAt: '—',
}

export function MappingEditPage() {
  const { mappingId = '' } = useParams<{ mappingId: string }>()
  const navigate = useNavigate()
  const streamNum = /^\d+$/.test(mappingId) ? Number(mappingId) : null
  const [meta, setMeta] = useState<MappingMeta>(EMPTY_META)
  const [rows, setRows] = useState<MappingRowModel[]>([])
  const [transformRules, setTransformRules] = useState<AdvancedTransformRuleDraft[]>([])
  const [preservedFieldMappings, setPreservedFieldMappings] = useState<Record<string, unknown>>({})
  const [enrichment, setEnrichment] = useState<Record<string, unknown>>({})
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(true)
  const [enrichmentOverridePolicy, setEnrichmentOverridePolicy] = useState<
    'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
  >('KEEP_EXISTING')
  const [eventArrayPath, setEventArrayPath] = useState('')
  const [eventRootPath, setEventRootPath] = useState('')
  const [rawPayloadMode, setRawPayloadMode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (streamNum == null) {
      setMeta(EMPTY_META)
      setRows([])
      setLoadError('Mapping edit requires a numeric stream id in the URL.')
      return
    }
    setLoading(true)
    setLoadError(null)
    void loadMappingWorkspaceContext(streamNum)
      .then((ctx) => {
        if (cancelled || !ctx) {
          if (!cancelled) setLoadError('Could not load stream or mapping-ui config.')
          return
        }
        const { stream, cfg, connectorName } = ctx
        const fm = (cfg.mapping?.field_mappings ?? {}) as Record<string, unknown>
        setRows(Object.keys(fm).length > 0 ? rowsFromFieldMappings(fm) : [])
        setTransformRules(parseTransformRulesFromFieldMappings(fm))
        setPreservedFieldMappings(extractPreservedFieldMappingMetadata(fm))
        setEventArrayPath(String(cfg.mapping?.event_array_path ?? ''))
        setEventRootPath(String(cfg.mapping?.event_root_path ?? ''))
        setRawPayloadMode(cfg.mapping?.raw_payload_mode ?? null)
        setEnrichment((cfg.enrichment?.enrichment ?? {}) as Record<string, unknown>)
        setEnrichmentEnabled(cfg.enrichment?.enabled !== false)
        const policy = cfg.enrichment?.override_policy
        setEnrichmentOverridePolicy(
          policy === 'OVERRIDE' || policy === 'ERROR_ON_CONFLICT' || policy === 'KEEP_EXISTING'
            ? policy
            : 'KEEP_EXISTING',
        )
        setMeta({
          connector: connectorName,
          stream: cfg.stream_name || stream.name || `Stream ${streamNum}`,
          sourceType: cfg.source_type ?? stream.stream_type ?? '—',
          status: stream.enabled === false ? 'INACTIVE' : 'ACTIVE',
          updatedAt: stream.updated_at?.slice(0, 19).replace('T', ' ') ?? '—',
        })
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Load failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [streamNum, mappingId])

  const mappedCount = useMemo(() => rows.filter((r) => r.outputField.trim() && r.sourceJsonPath.trim()).length, [rows])

  async function handleSave() {
    if (streamNum == null || isSaving) return
    const valid = rows.filter((r) => r.outputField.trim() && r.sourceJsonPath.trim())
    const advanced = transformRules.filter((rule) => rule.outputField.trim())
    if (
      valid.length === 0 &&
      advanced.length === 0 &&
      Object.keys(preservedFieldMappings).length === 0
    ) {
      setSaveMessage('Add at least one mapping row or Advanced Transform rule before saving.')
      return
    }
    setIsSaving(true)
    setSaveMessage(null)
    try {
      const fieldMappings = {
        ...preservedFieldMappings,
        ...buildFieldMappingsWithTransformRules(
          fieldMappingsFromRows(valid),
          transformRules,
        ),
      }
      const res = await saveStreamMappingUiConfigStrict(streamNum, {
        mapping: {
          field_mappings: fieldMappings,
          event_array_path: eventArrayPath || null,
          event_root_path: eventRootPath || null,
          raw_payload_mode: rawPayloadMode,
        },
      })
      setSaveMessage(res.message)
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="w-full min-w-0 space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-slate-200/70 bg-white/80 p-3 dark:border-gdc-border dark:bg-gdc-card">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Edit Mapping</h2>
            <StatusBadge tone={meta.status === 'ACTIVE' ? 'success' : 'neutral'}>{meta.status}</StatusBadge>
            {loading ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden /> : null}
          </div>
          <p className="text-[13px] text-slate-600 dark:text-gdc-muted">
            Map source fields to destination schema with live runtime preview and validation.
          </p>
          {loadError ? <p className="text-[12px] font-medium text-amber-800 dark:text-amber-200">{loadError}</p> : null}
          {saveMessage ? <p className="text-[12px] font-medium text-emerald-700 dark:text-emerald-300">{saveMessage}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/mappings')}
            className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-[12px] font-medium hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSaving || streamNum == null}
            onClick={() => void handleSave()}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {isSaving ? 'Saving…' : 'Save Mapping'}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200/70 bg-white/80 p-3 text-[12px] dark:border-gdc-border dark:bg-gdc-card md:grid-cols-5">
        {[
          ['Connector', meta.connector],
          ['Stream', meta.stream],
          ['Source type', meta.sourceType],
          ['Mapped fields', String(mappedCount)],
          ['Last updated', meta.updatedAt],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="truncate pt-0.5 font-medium text-slate-800 dark:text-slate-100">{value}</p>
          </div>
        ))}
      </section>

      {!loading && streamNum != null ? (
        <MappingWorkspace
          streamId={streamNum}
          streamTitle={meta.stream}
          connectorLabel={meta.connector}
          sourceType={meta.sourceType}
          initialRows={rows}
          enrichment={enrichmentEnabled ? enrichment : {}}
          enrichmentOverridePolicy={enrichmentOverridePolicy}
          eventArrayPath={eventArrayPath}
          eventRootPath={eventRootPath}
          onRowsChange={setRows}
          onEventArrayPathChange={setEventArrayPath}
          transformRules={transformRules}
          onTransformRulesChange={setTransformRules}
          preservedFieldMappings={preservedFieldMappings}
        />
      ) : null}
    </div>
  )
}
