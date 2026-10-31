/**
 * Presentation helper for API failures.
 *
 * `requestJson` / `safeRequestJsonResult` keep throwing `"<status>: [CODE] message"` strings: other code
 * (for example the password-change gate and stale-write handling) matches on that prefix, so the
 * transport format stays unchanged. Anything rendered to an operator goes through this helper instead
 * of printing the transport string, so HTTP status numbers and internal error codes do not leak into
 * banners, alerts and dialogs.
 */

export type ParsedApiError = {
  status: number | null
  code: string | null
  message: string
}

const STATUS_PREFIX = /^\s*(\d{3}):\s*/
const CODE_PREFIX = /^\s*\[([A-Za-z0-9_.-]+)\]\s*/

const PERMISSION_MESSAGE =
  'You do not have permission to do this. Ask an Operator or Administrator, or sign in with a role that can.'

/** Operator-facing wording for the transport codes that need more than the raw backend text. */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  ROLE_FORBIDDEN: PERMISSION_MESSAGE,
}

function fallbackForStatus(status: number | null): string | null {
  if (status == null) return null
  if (status === 401) return 'Your session has expired or is not valid. Sign in again.'
  if (status === 403) return PERMISSION_MESSAGE
  if (status === 404) return 'The requested item was not found. It may have been removed.'
  if (status === 409) return 'This conflicts with the current state of the item. Refresh and try again.'
  if (status === 422 || status === 400) {
    return 'The server rejected the request as invalid. Check the entered values and try again.'
  }
  if (status >= 500) return 'The server could not complete the request. Try again, or check the API logs.'
  return null
}

export function parseApiError(input: unknown, fallback = 'Something went wrong. Try again.'): ParsedApiError {
  const raw = input instanceof Error ? input.message : typeof input === 'string' ? input : ''
  let rest = raw
  let status: number | null = null
  let code: string | null = null

  const statusMatch = STATUS_PREFIX.exec(rest)
  if (statusMatch) {
    status = Number(statusMatch[1])
    rest = rest.slice(statusMatch[0].length)
  }
  const codeMatch = CODE_PREFIX.exec(rest)
  if (codeMatch) {
    code = codeMatch[1]
    rest = rest.slice(codeMatch[0].length)
  }
  const cleaned = rest.trim()

  if (code && CODE_MESSAGES[code]) return { status, code, message: CODE_MESSAGES[code] }
  if (cleaned && cleaned.toLowerCase() !== 'request failed') return { status, code, message: cleaned }
  return { status, code, message: fallbackForStatus(status) ?? (raw.trim() ? cleaned || fallback : fallback) }
}

/** The message to show an operator: no HTTP status prefix, no `[ERROR_CODE]` prefix. */
export function formatApiErrorMessage(input: unknown, fallback?: string): string {
  return parseApiError(input, fallback).message
}

/** True when the transport error is an authorization refusal (HTTP 403) rather than a failure. */
export function isForbiddenApiError(input: unknown): boolean {
  const parsed = parseApiError(input)
  return parsed.status === 403 || parsed.code === 'ROLE_FORBIDDEN'
}
