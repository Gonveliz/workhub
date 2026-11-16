import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REMOTE_INVOKES, REMOTE_MESSAGES } from '../src/main/remote/allowlist'

const SRC = resolve(__dirname, '../src')

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourcesUnder(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/** Code only: a `hub.x.y` or a channel name in a comment is not a call. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function resolveImport(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec)
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find((p) => existsSync(p))
}

/** The web client's files and every renderer file they import: shared screens, store and helpers. */
function clientFiles(): string[] {
  const seen = new Set<string>()
  const queue = sourcesUnder(join(SRC, 'web'))
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) {
      const next = resolveImport(file, m[1]!)
      if (next && !seen.has(next) && (next.startsWith(join(SRC, 'web')) || next.startsWith(join(SRC, 'renderer')))) queue.push(next)
    }
  }
  return [...seen]
}

/** `ns.method` (or `method`) of the `hub` → the channel it invokes or sends, read from the one file that builds it. */
function hubChannels(): Map<string, string> {
  const out = new Map<string, string>()
  let namespace: string | null = null
  for (const line of readFileSync(join(SRC, 'shared/hub-client.ts'), 'utf8').split('\n')) {
    const ns = /^ {4}(\w+): \{$/.exec(line)
    if (ns) {
      namespace = ns[1]!
      continue
    }
    if (/^ {4}\w+:/.test(line)) namespace = null
    const call = /^ {4,6}(\w+): .*?\b(?:invoke|send)\('([^']+)'/.exec(line)
    if (call) out.set(namespace && /^ {6}/.test(line) ? `${namespace}.${call[1]}` : call[1]!, call[2]!)
  }
  return out
}

/** Every channel the phone's web client asks main for, by `hub` method or by a channel name given to its transport. */
function channelsTheClientCalls(): Set<string> {
  const byMethod = hubChannels()
  const used = new Set<string>()
  for (const file of clientFiles()) {
    const text = withoutComments(readFileSync(file, 'utf8'))
    for (const m of text.matchAll(/\bhub\.(\w+)(?:\.(\w+))?/g)) {
      const channel = (m[2] && byMethod.get(`${m[1]}.${m[2]}`)) ?? byMethod.get(m[1]!)
      if (channel) used.add(channel)
    }
    if (file.startsWith(join(SRC, 'web'))) for (const m of text.matchAll(/\b(?:invoke|send)\(\s*'([^']+)'/g)) used.add(m[1]!)
  }
  return used
}

describe('the remote allowlist', () => {
  it('reads the hub methods it checks against', () => {
    const map = hubChannels()
    expect(map.get('sessions.start')).toBe('sessions:start')
    expect(map.get('profileFolders')).toBe('hub:profileFolders')
    expect(map.get('sessions.respondPermission')).toBe('sessions:permission')
  })

  it('names only call channels the phone web client uses', () => {
    const used = channelsTheClientCalls()
    // sessionGroups.lookUpHistory is the one renderer helper that calls history:find; the web
    // client imports its module for other helpers and never calls it.
    const web = sourcesUnder(join(SRC, 'web')).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(web).not.toContain('lookUpHistory')
    used.delete('history:find')
    const unused = [...Object.keys(REMOTE_INVOKES), ...Object.keys(REMOTE_MESSAGES)].filter((c) => !used.has(c))
    expect(unused).toEqual([])
  })

  it('leaves every write on a pull request closed', () => {
    for (const channel of ['codeHost:review', 'codeHost:comment', 'codeHost:reply', 'codeHost:close']) expect(REMOTE_INVOKES[channel]).toBeUndefined()
  })
})
