/**
 * Practical IANA timezone options for display settings.
 * Prefer the runtime Intl catalog; fall back to a curated operable set.
 * Normalize ICU legacy aliases so every selectable value is accepted by
 * backend `validate_iana_timezone` (Python zoneinfo).
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

/**
 * ICU / Intl may expose legacy Link names that Python zoneinfo rejects.
 * Map those to the canonical identifiers ZoneInfo accepts.
 */
const LEGACY_IANA_ALIAS_TO_CANONICAL: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
}

/** Map ICU legacy aliases to ZoneInfo-compatible IANA identifiers. */
export function canonicalizeIanaTimezone(timezone: string): string {
  return LEGACY_IANA_ALIAS_TO_CANONICAL[timezone] ?? timezone
}

function sortTimezones(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

function toBackendCompatibleTimezones(values: Iterable<string>): string[] {
  return sortTimezones(Array.from(values, canonicalizeIanaTimezone))
}

/** Full practical IANA list for display-timezone selects. */
export function listIanaTimezones(): string[] {
  try {
    const supported = Intl.supportedValuesOf?.('timeZone')
    if (Array.isArray(supported) && supported.length > 0) {
      return toBackendCompatibleTimezones(['UTC', ...supported])
    }
  } catch {
    /* use fallback */
  }
  return toBackendCompatibleTimezones(FALLBACK_IANA_TIMEZONES)
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
