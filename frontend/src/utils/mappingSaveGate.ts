/**
 * Stop-first gate for the legacy mapping screens (F-173).
 *
 * The Edit Stream page refuses to save platform configuration unless the stream is stopped
 * (`STOPPED` or `IDLE`), because a mapping saved on a running stream changes the very next
 * delivery with no draft/apply step. The legacy `/streams/:id/mapping` and `/mappings/:id/edit`
 * screens saved straight to the running stream. They use the same rule through this helper.
 */
export const MAPPING_STOP_FIRST_MESSAGE =
  'Stop the Stream before saving mapping changes to the platform. Your edits stay on this page; the running configuration was not changed.'

const SAVE_ALLOWED_STATUSES: ReadonlySet<string> = new Set(['STOPPED', 'IDLE'])

/** Returns the reason a mapping save must wait, or null when the stream is stopped. */
export function mappingSaveBlockedReason(status: string | null | undefined): string | null {
  const normalized = String(status ?? '').trim().toUpperCase()
  return SAVE_ALLOWED_STATUSES.has(normalized) ? null : MAPPING_STOP_FIRST_MESSAGE
}
