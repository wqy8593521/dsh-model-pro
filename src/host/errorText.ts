/** Render arbitrary provider/SDK failures without leaking `[object Object]`.
 *
 * Provider bridges are not perfectly uniform: `message` can itself be an
 * OpenAI-style `{ error: { message } }`, an array of validation details, or a
 * null-code envelope. This bounded, cycle-safe extractor prefers human text and
 * only falls back to JSON for otherwise useful structured data.
 */

const KEYS = ['message', 'error', 'detail', 'reason', 'failure', 'cause', 'description'] as const

export function errorText(value: unknown, fallback = '模型调用失败'): string {
  const seen = new Set<unknown>()

  const visit = (input: unknown, depth: number): string => {
    if (input === null || input === undefined) return ''
    if (typeof input === 'string') {
      const text = input.trim()
      return text && text !== '[object Object]' ? text : ''
    }
    if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') return String(input)
    if (depth >= 5 || (typeof input !== 'object' && typeof input !== 'function')) return ''
    if (seen.has(input)) return ''
    seen.add(input)

    const object = input as Record<string, unknown>
    for (const key of KEYS) {
      let nested: unknown
      try { nested = object[key] } catch { continue }
      const text = visit(nested, depth + 1)
      if (text) return text
    }
    if (Array.isArray(input)) {
      const parts = input.map((item) => visit(item, depth + 1)).filter(Boolean)
      if (parts.length) return parts.join('; ')
    }
    try {
      const json = JSON.stringify(input)
      if (json && json !== '{}' && json !== '[]') return json
    } catch { /* cyclic or hostile object */ }
    return ''
  }

  return visit(value, 0) || fallback
}
