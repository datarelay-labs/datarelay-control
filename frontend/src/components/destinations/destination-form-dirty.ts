/** Destination edit form dirty comparison (semantic fingerprint). */

export type DestinationFormFingerprintInput = Record<string, unknown>

export function destinationFormFingerprint(form: DestinationFormFingerprintInput): string {
  return JSON.stringify(form)
}

export function isDestinationFormDirty(
  baseline: DestinationFormFingerprintInput | null,
  current: DestinationFormFingerprintInput,
): boolean {
  if (baseline == null) return false
  return destinationFormFingerprint(baseline) !== destinationFormFingerprint(current)
}
