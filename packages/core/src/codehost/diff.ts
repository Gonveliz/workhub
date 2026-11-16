import type { DiffFile, DiffFileStatus, DiffHunk } from './domain'

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const SIMPLE_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 }

/** UTF-8 bytes to text; an invalid or truncated sequence becomes U+FFFD (core has no TextDecoder). */
function decodeUtf8(bytes: number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!
    const need = b < 0x80 ? 0 : b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1
    if (need < 0) {
      out += '\ufffd'
      i++
      continue
    }
    let code = need === 0 ? b : b & (0x3f >> need)
    let n = 0
    while (n < need && i + 1 + n < bytes.length && (bytes[i + 1 + n]! & 0xc0) === 0x80) code = (code << 6) | (bytes[i + 1 + n++]! & 0x3f)
    const min = [0, 0x80, 0x800, 0x10000][need]!
    if (n < need || code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      out += '\ufffd'
      i += n + 1
      continue
    }
    out += String.fromCodePoint(code)
    i += need + 1
  }
  return out
}

/** Decodes git's C-style quoting: simple escapes and octal bytes (`\303\255`), the bytes read as UTF-8. */
function unquote(path: string): string {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path
  const body = path.slice(1, -1)
  let out = ''
  let bytes: number[] = []
  const flush = () => {
    out += decodeUtf8(bytes)
    bytes = []
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== '\\' || i === body.length - 1) {
      flush()
      out += c
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4))
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff)
      i += octal[0].length
    } else {
      const simple = SIMPLE_ESCAPES[body[i + 1]!]
      if (simple !== undefined) bytes.push(simple)
      else {
        flush()
        out += body[i + 1]!
      }
      i++
    }
  }
  flush()
  return out
}

function stripPrefix(path: string): string {
  return unquote(path).replace(/^[ab]\//, '')
}

/** The path of a `--- ` / `+++ ` line: git appends a tab after a name with spaces. Null for `/dev/null`. */
function markerPath(rest: string): string | null {
  // A cut at the first tab, not `/\t.*$/`, which backtracks over every tab before a `\r` (quadratic).
  const tab = rest.indexOf('\t')
  const path = tab < 0 ? rest : rest.slice(0, tab)
  return path === '/dev/null' ? null : stripPrefix(path)
}

/**
 * The two paths of a `diff --git` header, used only when no `---`/`+++`/rename line follows
 * (mode-only and binary changes). A quoted name is delimited; an unquoted one may hold spaces, so
 * the split is the middle when both sides name the same file, else the first ` b/`.
 */
function headerPaths(rest: string): [string, string] {
  const quoted = /^("(?:[^"\\]|\\.)*") (.+)$/.exec(rest)
  if (quoted) return [stripPrefix(quoted[1]!), stripPrefix(quoted[2]!)]
  const tail = /^(.+) ("(?:[^"\\]|\\.)*")$/.exec(rest)
  if (tail && rest.startsWith('a/')) return [stripPrefix(tail[1]!), stripPrefix(tail[2]!)]
  const mid = (rest.length - 1) / 2
  if (Number.isInteger(mid) && rest[mid] === ' ' && rest.slice(2, mid) === rest.slice(mid + 3)) return [stripPrefix(rest.slice(0, mid)), stripPrefix(rest.slice(mid + 1))]
  const split = rest.indexOf(' b/')
  if (split > 0) return [stripPrefix(rest.slice(0, split)), stripPrefix(rest.slice(split + 1))]
  const [x = '', y = x] = rest.split(' ')
  return [stripPrefix(x), stripPrefix(y)]
}

/**
 * Parses a unified diff (`git diff` / `gh pr diff` output) into files, hunks and numbered lines.
 * Lenient: text it does not understand is skipped, never thrown on.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  // The `--- ` path of the current file, to tell a rename from the `+++ ` line that follows.
  let oldName: string | null = null

  const open = (path: string, oldPath?: string): DiffFile => {
    const f: DiffFile = { path, oldPath, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] }
    files.push(f)
    hunk = null
    return f
  }

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('diff --git ')) {
      const [a, b] = headerPaths(line.slice(11))
      file = open(b, a !== b ? a : undefined)
      if (a !== b) file.status = 'renamed'
      oldName = null
      continue
    }
    if (!file) continue
    if (hunk === null) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.oldPath = unquote(line.slice(12))
        file.status = 'renamed'
      } else if (line.startsWith('rename to ')) {
        file.path = unquote(line.slice(10))
        file.status = 'renamed'
      }
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) file.binary = true
      else if (line.startsWith('--- ')) {
        // The marker lines carry the real names; the header above can only guess when they hold spaces.
        oldName = markerPath(line.slice(4))
        if (oldName === null) file.status = 'added'
        else file.path = oldName
      } else if (line.startsWith('+++ ')) {
        const name = markerPath(line.slice(4))
        if (name === null) file.status = 'deleted'
        else {
          file.path = name
          if (oldName !== null && oldName !== name) {
            file.oldPath = oldName
            file.status = 'renamed'
          } else if (oldName !== null) {
            file.oldPath = undefined
            if (file.status === 'renamed') file.status = 'modified'
          }
        }
      }
    }
    const h = HUNK.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    const current: DiffHunk = hunk
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'added', newNumber: newNo++, text: line.slice(1) })
      file.additions++
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'removed', oldNumber: oldNo++, text: line.slice(1) })
      file.deletions++
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', oldNumber: oldNo++, newNumber: newNo++, text: line.slice(1) })
    }
    // "\ No newline at end of file" and blank trailing lines carry no code.
  }
  return files
}

/** A one-file unified diff from a host that sends only the hunks (GitLab's `diffs` API). */
export function diffFileFromHunks(info: { path: string; oldPath?: string; status: DiffFileStatus }, hunksText: string): DiffFile {
  const header = `diff --git a/${info.oldPath ?? info.path} b/${info.path}\n`
  const [parsed] = parseUnifiedDiff(header + hunksText)
  const file: DiffFile = parsed ?? { path: info.path, status: info.status, binary: false, additions: 0, deletions: 0, hunks: [] }
  return { ...file, path: info.path, oldPath: info.oldPath && info.oldPath !== info.path ? info.oldPath : undefined, status: info.status }
}
