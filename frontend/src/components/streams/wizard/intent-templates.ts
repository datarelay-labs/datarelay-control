import { buildInitialState, type WizardState } from './wizard-state'

export type WizardIntentTemplateId =
  | 'api-logs-siem' | 'database-collection' | 'multi-destination' | 'archive-raw' | 'protect-sensitive' | 'scratch'

export type WizardIntentTemplate = { id: WizardIntentTemplateId; title: string; description: string; seeds: string[] }

export const WIZARD_INTENT_TEMPLATES: readonly WizardIntentTemplate[] = [
  { id: 'api-logs-siem', title: 'Send API logs to a SIEM', description: 'Start with an HTTP API polling source and a log-friendly Stream draft.', seeds: ['HTTP API polling source', 'Stream name: API Logs', 'Review destinations before deploy'] },
  { id: 'database-collection', title: 'Collect database data', description: 'Start with the database query source path and review the query/checkpoint before testing.', seeds: ['Database query source', 'Stream name: Database Data', 'No query or credentials are guessed'] },
  { id: 'multi-destination', title: 'Send one Stream to multiple destinations', description: 'Keep the standard source flow and emphasize selecting more than one delivery target.', seeds: ['Stream name: Multi-destination Stream', 'Destination selection remains manual', 'Route Processing remains editable per destination'] },
  { id: 'archive-raw', title: 'Archive raw data', description: 'Start with pass-through mapping so the original event shape remains the default.', seeds: ['Stream name: Raw Archive', 'Pass through unmapped fields', 'Archive destination remains your choice'] },
  { id: 'protect-sensitive', title: 'Protect sensitive data before delivery', description: 'Start with strict protection defaults while keeping every rule reviewable before deploy.', seeds: ['Stream name: Protected Delivery', 'Strict data policy', 'Unknown sensitive fields require review'] },
  { id: 'scratch', title: 'Start from scratch', description: 'Use the existing Stream Wizard defaults with no intent-specific seed values.', seeds: ['No template changes', 'Existing five-stage wizard behavior'] },
] as const

export function applyWizardIntentTemplate(id: WizardIntentTemplateId): WizardState {
  const state = buildInitialState()
  if (id === 'api-logs-siem') state.stream.name = 'API Logs'
  if (id === 'database-collection') { state.connector.sourceType = 'DATABASE_QUERY'; state.stream.name = 'Database Data' }
  if (id === 'multi-destination') state.stream.name = 'Multi-destination Stream'
  if (id === 'archive-raw') { state.stream.name = 'Raw Archive'; state.unmappedFieldsPolicy = 'pass_through' }
  if (id === 'protect-sensitive') {
    state.stream.name = 'Protected Delivery'
    state.dataPolicy = { ...state.dataPolicy, preset: 'strict', maskPii: true, defaultMaskMode: 'full', restrictedResponse: 'quarantine', confidentialResponse: 'quarantine' }
    state.dataProtection = { ...state.dataProtection, unknownSensitiveFieldPolicy: 'require_review' }
  }
  return state
}
