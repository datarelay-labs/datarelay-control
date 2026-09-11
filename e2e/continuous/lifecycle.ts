/**
 * Continuous E2E lifecycle helpers.
 * Distinct ownership from ephemeral Full E2E (`full-e2e-lab`).
 */
export const CONTINUOUS_OWNERSHIP = 'continuous-e2e-lab' as const
export const EPHEMERAL_OWNERSHIP = 'full-e2e-lab' as const
export const CONTINUOUS_NAME_PREFIX = '[CONTINUOUS E2E]'

export type ResourceLifecycle = 'ephemeral' | 'continuous'
export type OwnershipTag = typeof CONTINUOUS_OWNERSHIP | typeof EPHEMERAL_OWNERSHIP

export function ownershipForLifecycle(lifecycle: ResourceLifecycle): OwnershipTag {
  return lifecycle === 'continuous' ? CONTINUOUS_OWNERSHIP : EPHEMERAL_OWNERSHIP
}

export function isContinuousOwnership(ownership: string | undefined | null): boolean {
  return ownership === CONTINUOUS_OWNERSHIP
}

export function isEphemeralOwnership(ownership: string | undefined | null): boolean {
  return ownership === EPHEMERAL_OWNERSHIP
}

/** Ordinary ephemeral cleanup must refuse continuous registries. */
export function refuseEphemeralCleanupOfContinuous(ownership: string | undefined | null): boolean {
  return isContinuousOwnership(ownership)
}
