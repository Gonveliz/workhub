/** A small reader for XML property lists, such as the output of `defaults export <domain> -`. */

export type PlistValue = string | number | boolean | Date | Uint8Array | PlistValue[] | { [key: string]: PlistValue }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? m
  })
}

/** A small XML property list parser: dict, array, string, data, integer, real, date, true, false. */
export function parsePlist(xml: string): PlistValue {
  const tokens = [...xml.matchAll(/<(\/?)([a-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/gi)]
  let i = 0
  const next = () => tokens[i++]
  const text = (): string => {
    const t = tokens[i]
    if (t && t[4] !== undefined) {
      i++
      return unescape(t[4])
    }
    return ''
  }
  const close = (tag: string) => {
    const t = next()
    if (!t || t[1] !== '/' || t[2] !== tag) throw new Error(`malformed plist near <${tag}>`)
  }
  const value = (): PlistValue => {
    let t = next()
    while (t && t[4] !== undefined) t = next() // whitespace between elements
    if (!t) throw new Error('unexpected end of plist')
    const tag = t[2]!
    const empty = t[3] === '/'
    switch (tag) {
      case 'dict': {
        const out: Record<string, PlistValue> = {}
        if (empty) return out
        for (;;) {
          let k = next()
          while (k && k[4] !== undefined) k = next()
          if (!k) throw new Error('unterminated dict')
          if (k[1] === '/' && k[2] === 'dict') return out
          if (k[2] !== 'key') throw new Error('expected a key in dict')
          const key = text()
          close('key')
          out[key] = value()
        }
      }
      case 'array': {
        const out: PlistValue[] = []
        if (empty) return out
        for (;;) {
          while (tokens[i] && tokens[i]![4] !== undefined) i++
          const t2 = tokens[i]
          if (!t2) throw new Error('unterminated array')
          if (t2[1] === '/' && t2[2] === 'array') {
            i++
            return out
          }
          out.push(value())
        }
      }
      case 'true':
      case 'false':
        return tag === 'true'
      case 'string':
      case 'key': {
        if (empty) return ''
        const s = text()
        close(tag)
        return s
      }
      case 'integer':
      case 'real': {
        const s = text()
        close(tag)
        return Number(s.trim())
      }
      case 'date': {
        const s = text()
        close(tag)
        return new Date(s.trim())
      }
      case 'data': {
        if (empty) return new Uint8Array()
        const s = text()
        close(tag)
        return Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'base64'))
      }
      default:
        throw new Error(`unsupported plist element <${tag}>`)
    }
  }
  // Skip the prolog and the <plist> wrapper.
  while (i < tokens.length && tokens[i]![2] !== 'plist') i++
  i++
  return value()
}
