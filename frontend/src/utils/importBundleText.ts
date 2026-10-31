/**
 * Parse the text of a backup/import bundle for Backup & Import.
 *
 * Browser JSON errors ("Unexpected token 'h', \"this is not json {\" is not valid JSON") and API schema
 * errors ("Input should be a valid dictionary") are engine messages. This helper turns them into a
 * sentence that says what is wrong with the file and what to do (F-215).
 */
export type ImportBundleParse = { ok: true; bundle: Record<string, unknown> } | { ok: false; message: string }

export function parseImportBundleText(text: string): ImportBundleParse {
  const trimmed = text.trim()
  if (!trimmed) {
    return { ok: false, message: 'The import text is empty. Choose a file or paste JSON produced by Download JSON.' }
  }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return {
      ok: false,
      message:
        'This is not valid JSON, or the file is incomplete (for example truncated). Choose the file produced by Download JSON and try again.',
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      message:
        'The import must be a JSON object with a "connectors" list, as produced by Download JSON. A list or plain value cannot be imported.',
    }
  }
  return { ok: true, bundle: value as Record<string, unknown> }
}
