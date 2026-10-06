import { describe, expect, it } from 'vitest'
import { applyWizardIntentTemplate, WIZARD_INTENT_TEMPLATES } from './intent-templates'

describe('wizard intent templates', () => {
  it('offers the six canonical starting points', () => {
    expect(WIZARD_INTENT_TEMPLATES.map((item) => item.id)).toEqual(['api-logs-siem','database-collection','multi-destination','archive-raw','protect-sensitive','scratch'])
  })
  it('keeps scratch identical to current defaults', () => {
    expect(applyWizardIntentTemplate('scratch').stream.name).toBe('Generic HTTP Events')
    expect(applyWizardIntentTemplate('scratch').destinations.routeDrafts).toEqual([])
  })
  it('seeds intent without creating destinations or deploying', () => {
    const db = applyWizardIntentTemplate('database-collection')
    expect(db.connector.sourceType).toBe('DATABASE_QUERY')
    expect(db.stream.sqlQuery).toBe('')
    expect(db.destinations.routeDrafts).toEqual([])
    expect(db.outcome).toBeNull()
    const protectedState = applyWizardIntentTemplate('protect-sensitive')
    expect(protectedState.dataPolicy.preset).toBe('strict')
    expect(protectedState.dataProtection.unknownSensitiveFieldPolicy).toBe('require_review')
  })
})
