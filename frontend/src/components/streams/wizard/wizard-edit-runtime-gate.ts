/** Confirmed baseline changes only after load or a successful persist. */
export function shouldScheduleEditAutosave(
  draftSnapshot: string,
  confirmedSavedSnapshot: string,
  failedAttemptSnapshot: string | null,
): boolean {
  if (draftSnapshot === confirmedSavedSnapshot) return false
  if (failedAttemptSnapshot != null && draftSnapshot === failedAttemptSnapshot) return false
  return true
}

/** Start and Run Now require the visible draft to match the last confirmed save. Stop stays separate. */
export function editRuntimeVerificationBlocked(input: {
  isSaving: boolean
  saveFailed: boolean
  persistErrorCount: number
  draftSnapshot: string
  confirmedSavedSnapshot: string
}): boolean {
  if (input.isSaving) return true
  if (input.saveFailed) return true
  if (input.persistErrorCount > 0) return true
  return input.draftSnapshot !== input.confirmedSavedSnapshot
}
