export type MaterializedStreamRow = {
  stream_id: number
  config_json?: unknown
}

export type WizardStreamConfigureTarget = {
  streamId: number
  configJson?: Record<string, unknown>
}

/**
 * Explicit behavior A: every materialized stream receives downstream wizard configuration.
 * Never silently select only createdStreams[0].
 */
export function buildStreamsToConfigureFromMaterialization(
  createdStreams: MaterializedStreamRow[],
): WizardStreamConfigureTarget[] {
  return createdStreams.map((row) => {
    const cfg =
      row.config_json && typeof row.config_json === 'object' && !Array.isArray(row.config_json)
        ? { ...(row.config_json as Record<string, unknown>) }
        : undefined
    return { streamId: row.stream_id, configJson: cfg }
  })
}

export function wizardPersistErrorLabel(
  streamId: number,
  message: string,
  options: { multiStream: boolean },
): string {
  return options.multiStream ? `stream ${streamId}: ${message}` : message
}
