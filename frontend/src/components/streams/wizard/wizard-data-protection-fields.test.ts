import { describe, expect, it } from 'vitest'
import {
  collectWizardDetectedFieldCandidates,
  inferWizardSensitivityClass,
  suggestLikelySensitiveFields,
  suggestLikelySensitiveFieldsFromState,
} from './wizard-data-protection-fields'
import { buildInitialState } from './wizard-state'

describe('wizard-data-protection-fields', () => {
  it('infers secret class from password-like paths', () => {
    expect(inferWizardSensitivityClass('$.user.password')).toBe('secret')
    expect(inferWizardSensitivityClass('$.api_key')).toBe('secret')
  })

  it('infers pii class from email-like paths', () => {
    expect(inferWizardSensitivityClass('$.user.email')).toBe('pii')
  })

  it('collects candidates from mapped runtime event paths', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ email: 'a@b.c', token: 'x', id: '1' }]
    state.mapping = [{ id: 'm1', outputField: 'event_id', sourceJsonPath: '$.id' }]
    const candidates = collectWizardDetectedFieldCandidates(state)
    expect(candidates).toContain('$.email')
    expect(candidates).toContain('$.token')
    expect(candidates).toContain('$.event_id')
  })

  it('collects mapping rename output path after flatten', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ user: { email: 'a@b.c' } }]
    state.mapping = [{ id: 'm1', outputField: 'email', sourceJsonPath: '$.user.email' }]
    const candidates = collectWizardDetectedFieldCandidates(state)
    expect(candidates).toContain('$.email')
    expect(candidates).not.toContain('$.user.email')
  })

  it('suggests likely sensitive fields from candidates using union field rules', () => {
    const likely = suggestLikelySensitiveFields(['$.id', '$.user.email', '$.count', '$.random_field'])
    expect(likely).toContain('$.user.email')
    expect(likely).not.toContain('$.count')
    expect(likely).not.toContain('$.id')
    expect(likely).not.toContain('$.random_field')
  })

  it('suggests fields with email sample values even when field name is generic', () => {
    const samples = new Map<string, readonly unknown[]>([['$.contact', ['user@example.com']]])
    const likely = suggestLikelySensitiveFields(['$.contact', '$.status'], samples)
    expect(likely).toContain('$.contact')
    expect(likely).not.toContain('$.status')
  })

  it('suggests likely sensitive fields from wizard state with sample values', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ email: 'a@b.c', id: '1', status: 'ok' }]
    const likely = suggestLikelySensitiveFieldsFromState(state)
    expect(likely).toContain('$.email')
    expect(likely).not.toContain('$.id')
    expect(likely).not.toContain('$.status')
  })

  it('suggests a card number by field name and by grouped sample value (F-156)', () => {
    const likely = suggestLikelySensitiveFields(['$.card', '$.card_number', '$.ref', '$.note', '$.serial'], new Map<string, readonly unknown[]>([
      ['$.ref', ['4111-1111-1111-1111']],
      ['$.note', ['4111-1111-1111-NNNN']],
      ['$.serial', ['1234-5678-9012-3456']],
    ]))
    expect(likely).toContain('$.card')
    expect(likely).toContain('$.card_number')
    expect(likely).toContain('$.ref')
    expect(likely).toContain('$.note')
    // Luhn-invalid digits grouped like a card are not suggested.
    expect(likely).not.toContain('$.serial')
  })

  it('suggests the card field from wizard state with the audit sample shape', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ user: { email: 'a@b.c' }, card: '4111-1111-1111-6407', id: 7 }]
    const likely = suggestLikelySensitiveFieldsFromState(state)
    expect(likely).toContain('$.card')
    expect(likely).toContain('$.user.email')
  })
})
