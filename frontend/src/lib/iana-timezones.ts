/**
 * Practical IANA timezone options for display settings.
 * Prefer the runtime Intl catalog; fall back to a curated operable set.
 */

const FALLBACK_IANA_TIMEZONES = [
  'UTC',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/New_York',
  'America/Sao_Paulo',
  'America/Toronto',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Kolkata',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/London',
  'Europe/Moscow',
  'Europe/Paris',
  'Pacific/Auckland',
] as const

function sortTimezones(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

/** Full practical IANA list for display-timezone selects. */
export function listIanaTimezones(): string[] {
  try {
    const supported = Intl.supportedValuesOf?.('timeZone')
    if (Array.isArray(supported) && supported.length > 0) {
      return sortTimezones(['UTC', ...supported])
    }
  } catch {
    /* use fallback */
  }
  return sortTimezones(FALLBACK_IANA_TIMEZONES)
}

/** Case-insensitive substring filter; empty query returns the full list. */
export function filterIanaTimezones(query: string, options: readonly string[] = listIanaTimezones()): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...options]
  return options.filter((tz) => tz.toLowerCase().includes(q))
}

/** Ensure the current value remains selectable even when filtered out or missing from the catalog. */
export function timezoneSelectOptions(
  currentValue: string,
  query: string,
  options: readonly string[] = listIanaTimezones(),
): string[] {
  const filtered = filterIanaTimezones(query, options)
  const current = currentValue.trim()
  if (!current || filtered.includes(current)) return filtered
  return sortTimezones([current, ...filtered])
}
