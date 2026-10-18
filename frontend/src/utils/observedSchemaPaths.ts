/** Field identity used by Wizard Union Schema and schema field trees.
 *
 * Plain ASCII paths retain existing $.field notation. Literal object members
 * containing punctuation are bracket quoted to remain different from nested
 * fields. The internal [] array marker is a schema pattern, not an RFC 9535
 * concrete normalized node path.
 */
const PLAIN_MEMBER = /^[A-Za-z_][A-Za-z0-9_]*$/

export type ObservedSchemaPathSegment =
  | { kind: 'field'; key: string }
  | { kind: 'array' }

export function appendObservedFieldPath(parent: string, key: string): string {
  if (PLAIN_MEMBER.test(key)) return parent + '.' + key
  let escaped = ''
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\') escaped += '\\\\'
    else if (char === "'") escaped += "\\'"
    else if (char === '\b') escaped += '\\b'
    else if (char === '\f') escaped += '\\f'
    else if (char === '\n') escaped += '\\n'
    else if (char === '\r') escaped += '\\r'
    else if (char === '\t') escaped += '\\t'
    else if (code < 32) escaped += '\\u' + code.toString(16).padStart(4, '0')
    else escaped += char
  }
  return parent + "['" + escaped + "']"
}

/** Parse observed *schema* patterns, including legacy $.a[].b spelling.
 *
 * Unsupported/malformed selectors return null. This must not be used as an
 * arbitrary JSONPath query parser: filters/unions require a real JSONPath
 * implementation, not a partial string splitter.
 */
export function parseObservedSchemaPath(path: string): ObservedSchemaPathSegment[] | null {
  if (!path.startsWith('$')) return null
  const tokens: ObservedSchemaPathSegment[] = []
  let i = 1
  while (i < path.length) {
    if (path[i] === '.') {
      const start = ++i
      while (i < path.length && path[i] !== '.' && path[i] !== '[') i++
      if (i === start) return null
      tokens.push({ kind: 'field', key: path.slice(start, i) })
      continue
    }
    if (path.slice(i, i + 2) === '[]' || path.slice(i, i + 3) === '[*]') {
      tokens.push({ kind: 'array' })
      i += path[i + 1] === '*' ? 3 : 2
      continue
    }
    if (path[i] === '[' && /[0-9]/.test(path[i + 1] ?? '')) {
      const end = path.indexOf(']', i + 1)
      if (end < 0 || !/^[0-9]+$/.test(path.slice(i + 1, end))) return null
      tokens.push({ kind: 'array' })
      i = end + 1
      continue
    }
    if (path[i] !== '[' || (path[i + 1] !== "'" && path[i + 1] !== '"')) return null
    const quote = path[i + 1]
    i += 2
    let key = ''
    let closed = false
    while (i < path.length) {
      const char = path[i++]
      if (char === quote) {
        closed = true
        break
      }
      if (char !== '\\') {
        key += char
        continue
      }
      if (i >= path.length) return null
      const escaped = path[i++]
      const mapped: Record<string, string> = {
        b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
        '\\': '\\', "'": "'", '"': '"',
      }
      if (escaped === 'u') {
        const hex = path.slice(i, i + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
        key += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else if (Object.prototype.hasOwnProperty.call(mapped, escaped)) {
        key += mapped[escaped]
      } else {
        return null
      }
    }
    if (!closed || path[i] !== ']') return null
    i++
    tokens.push({ kind: 'field', key })
  }
  return tokens
}
