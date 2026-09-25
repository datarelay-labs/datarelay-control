/** Confirmation copy for Route and Stream deletes. Must match backend blast radius. */

export const STREAM_DELETE_IMPACT_BULLETS = [
  'Permanently deletes this stream, its checkpoint, and its runtime state.',
  'Permanently deletes every route on this stream, including transform, protection, classification, and policy configuration.',
  'Permanently deletes delivery history for this stream and its routes.',
  'Connector, source, and destination records are kept.',
] as const

export const STREAM_DELETE_REVERSIBILITY =
  'Delete is permanent. Stop the stream first if it is still running.'

export const ROUTE_DELETE_REVERSIBILITY =
  'Adding this destination again creates a new delivery path and does not restore the deleted route configuration.'

const ROUTE_DELETE_IMPACT_BULLETS = [
  'Removes this delivery path from the stream. The destination and parent stream are kept.',
  'Permanently removes transform, protection, classification, and policy configuration for this path.',
  'Historical delivery logs are kept, but they are no longer associated with this path.',
] as const

export function routeDeleteImpactBullets(hasUnsavedPrefix: boolean): string[] {
  return [
    ...ROUTE_DELETE_IMPACT_BULLETS,
    ...(hasUnsavedPrefix
      ? ['Unsaved message-prefix edits for this route will also be discarded.']
      : []),
  ]
}
