import { describe, expect, it } from 'vitest'
import { formatApiErrorMessage, isForbiddenApiError, parseApiError } from './api-error-message'

describe('formatApiErrorMessage', () => {
  it('strips the HTTP status and internal error code from a login failure (F-001)', () => {
    expect(formatApiErrorMessage(new Error('400: [USER_AUTH_FAILED] Invalid username or password.'))).toBe(
      'Invalid username or password.',
    )
  })

  it('strips status and code prefixes from validation and delete-blocked failures (F-004, F-014)', () => {
    expect(formatApiErrorMessage('422: [CONNECTOR_VALIDATION_FAILED] Login base URL must not include a path.')).toBe(
      'Login base URL must not include a path.',
    )
    expect(
      formatApiErrorMessage(
        new Error('409: [STREAM_DELETE_BLOCKED_RUNNING] Stop the stream before deleting it.'),
      ),
    ).toBe('Stop the stream before deleting it.')
  })

  it('keeps plain messages and non-prefixed text untouched', () => {
    expect(formatApiErrorMessage(new Error('Network down'))).toBe('Network down')
    expect(formatApiErrorMessage('Connector name is required.')).toBe('Connector name is required.')
  })

  it('explains a bare "Request failed" by status instead of echoing it (F-010)', () => {
    expect(formatApiErrorMessage(new Error('422: Request failed'))).toMatch(/rejected the request as invalid/i)
    expect(formatApiErrorMessage(new Error('500: Request failed'))).toMatch(/could not complete the request/i)
    expect(formatApiErrorMessage(new Error('404: Request failed'))).toMatch(/not found/i)
  })

  it('turns ROLE_FORBIDDEN into a permission message (F-018)', () => {
    const msg = formatApiErrorMessage(new Error('403: [ROLE_FORBIDDEN] Role VIEWER cannot POST /destinations/4/test'))
    expect(msg).toMatch(/do not have permission/i)
    expect(msg).not.toContain('VIEWER')
    expect(msg).not.toContain('403')
  })

  it('falls back for empty or non-error input', () => {
    expect(formatApiErrorMessage(undefined, 'Delete failed.')).toBe('Delete failed.')
    expect(formatApiErrorMessage(new Error(''), 'Delete failed.')).toBe('Delete failed.')
    expect(formatApiErrorMessage({})).toBe('Something went wrong. Try again.')
  })
})

describe('parseApiError', () => {
  it('exposes the transport status and code for callers that branch on them', () => {
    expect(parseApiError('409: [ROUTE_STALE_WRITE] Route changed.')).toEqual({
      status: 409,
      code: 'ROUTE_STALE_WRITE',
      message: 'Route changed.',
    })
  })

  it('detects authorization refusals', () => {
    expect(isForbiddenApiError(new Error('403: [ROLE_FORBIDDEN] nope'))).toBe(true)
    expect(isForbiddenApiError(new Error('403: nope'))).toBe(true)
    expect(isForbiddenApiError(new Error('409: [X] nope'))).toBe(false)
  })
})
