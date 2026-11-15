/**
 * The text check of the read-only SQL endpoint (`/v1/analytics/query`). The query then runs in a
 * separate process (the app's `analytics-worker.ts`) on a connection opened read-only, with
 * `PRAGMA query_only = 1` and an SQLite authorizer built from the lists below; that process is killed when a query outlives its time budget. Layers, outermost first:
 *
 * 1. `checkReadOnlySql` tokenizes the text the way SQLite does (strings, quoted names, comments,
 *    numbers, parameters; never a naive regex) and refuses anything but one `SELECT` or `WITH`
 *    statement: no second statement, no write, schema or transaction keyword, no `PRAGMA`/`ATTACH`,
 *    no file, extension or blob-making function, and no table off `READABLE_TABLES` by name (as a
 *    word, a quoted name or a single-quoted string, which SQLite also accepts as a table name).
 * 2. The worker's connection: read-only file, `query_only`, the authorizer. Where the runtime has no
 *    authorizer the worker refuses every query ("read-only guard unavailable").
 * 3. The worker's process: a query that runs too long is killed, so it never holds the app.
 *
 * Values are bound parameters only.
 */
import { ANALYTICS_TABLES } from './analytics'

/** Tables a query may name: `ANALYTICS_TABLES`, and `sqlite_master`/`sqlite_schema` that describe them. */
export const READABLE_TABLES: readonly string[] = [...ANALYTICS_TABLES, 'sqlite_master', 'sqlite_schema']

/** Names refused anywhere, whatever the file holds: app state, schema bookkeeping, raw page access, temp schema. */
export const DENIED_NAMES: readonly string[] = ['kv_state', 'schema_migrations', 'sqlite_dbpage', 'dbstat', 'sqlite_temp_master', 'sqlite_temp_schema', 'sqlite_sequence', 'sqlite_stat1', 'sqlite_stat4']

/** Keywords that only belong to statements that write, change the schema, the connection or a transaction. */
const DENIED_KEYWORDS = new Set(['attach', 'detach', 'pragma', 'vacuum', 'insert', 'update', 'delete', 'create', 'drop', 'alter', 'reindex', 'analyze', 'begin', 'commit', 'rollback', 'savepoint', 'release', 'returning', 'into'])

/** Functions that read or write files, load code, reach into SQLite's internals or make huge blobs (no use in a report). */
export const DENIED_FUNCTIONS: readonly string[] = [
  'load_extension',
  'readfile',
  'writefile',
  'edit',
  'fts3_tokenizer',
  'zipfile',
  'sqlar_compress',
  'sqlar_uncompress',
  'sqlite_offset',
  'lsdir',
  'fsdir',
  'shell',
  'randomblob',
  'zeroblob'
]
const DENIED_FUNCTION_SET = new Set(DENIED_FUNCTIONS)

export const QUERY_LIMITS = { sqlBytes: 20 * 1024, defaultRows: 500, maxRows: 2000, budgetMs: 5000, params: 100, cellChars: 10_000 } as const

/** A string keeps its lowercased value: SQLite reads `FROM 'kv_state'` as a table name. */
type Token = { kind: 'word'; text: string } | { kind: 'name'; text: string } | { kind: 'string'; text: string } | { kind: 'number' } | { kind: 'param' } | { kind: 'punct'; text: string }

const isWordStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127
const isWordChar = (c: string | undefined) => c !== undefined && (/[\w$]/.test(c) || c.charCodeAt(0) > 127)
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const isHex = (c: string | undefined) => c !== undefined && /[0-9a-fA-F]/.test(c)

/** The tokens of `sql` without whitespace and comments; a string when SQLite could not read it either. */
export function tokenizeSql(sql: string): Token[] | string {
  const out: Token[] = []
  let i = 0
  const quoted = (close: string, from: number): number | null => {
    // A quote is escaped by doubling it ('it''s', "a""b"); brackets cannot be escaped.
    let j = from
    while (j < sql.length) {
      if (sql[j] === close) {
        if (close !== ']' && sql[j + 1] === close) {
          j += 2
          continue
        }
        return j
      }
      j++
    }
    return null
  }
  while (i < sql.length) {
    const c = sql[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? sql.length : nl + 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      if (close < 0) return 'unterminated comment'
      i = close + 2
      continue
    }
    if (c === "'" || ((c === 'x' || c === 'X') && sql[i + 1] === "'")) {
      const start = c === "'" ? i + 1 : i + 2
      const end = quoted("'", start)
      if (end === null) return 'unterminated string'
      out.push({ kind: 'string', text: sql.slice(start, end).split("''").join("'").toLowerCase() })
      i = end + 1
      continue
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      const end = quoted(close, i + 1)
      if (end === null) return 'unterminated quoted name'
      out.push({ kind: 'name', text: sql.slice(i + 1, end).split(close + close).join(close).toLowerCase() })
      i = end + 1
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(sql[i + 1]))) {
      // As SQLite reads them: 0x + hex digits; digits [. digits] [e [+-] digits], the exponent only
      // when a digit follows. A letter right after a number is an error in SQLite too.
      let j = i
      if (c === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X') && isHex(sql[i + 2])) {
        j = i + 2
        while (isHex(sql[j])) j++
      } else {
        while (isDigit(sql[j])) j++
        if (sql[j] === '.') {
          j++
          while (isDigit(sql[j])) j++
        }
        if ((sql[j] === 'e' || sql[j] === 'E') && (isDigit(sql[j + 1]) || ((sql[j + 1] === '+' || sql[j + 1] === '-') && isDigit(sql[j + 2])))) {
          j += 2
          while (isDigit(sql[j])) j++
        }
      }
      if (isWordChar(sql[j]) || sql[j] === '.') return `unrecognized token near "${sql.slice(i, j + 1)}"`
      out.push({ kind: 'number' })
      i = j
      continue
    }
    if (c === '?') {
      let j = i + 1
      while (isDigit(sql[j])) j++
      out.push({ kind: 'param' })
      i = j
      continue
    }
    if (c === ':' || c === '@' || c === '$') {
      let j = i + 1
      while (isWordChar(sql[j])) j++
      if (j === i + 1) return `a parameter needs a name after "${c}"`
      out.push({ kind: 'param' })
      i = j
      continue
    }
    if (isWordStart(c)) {
      let j = i + 1
      while (isWordChar(sql[j])) j++
      out.push({ kind: 'word', text: sql.slice(i, j).toLowerCase() })
      i = j
      continue
    }
    out.push({ kind: 'punct', text: c })
    i++
  }
  return out
}

/**
 * Why `sql` may not run, or null when it is one read-only statement over the readable tables.
 * `tables` are the file's own tables and views: those off `READABLE_TABLES` are refused by name.
 */
export function checkReadOnlySql(sql: string, tables: readonly string[] = []): string | null {
  if (typeof sql !== 'string' || !sql.trim()) return '"sql" must be a non-empty string'
  if (Buffer.byteLength(sql) > QUERY_LIMITS.sqlBytes) return `the query is longer than ${QUERY_LIMITS.sqlBytes / 1024} KB`
  const tokens = tokenizeSql(sql)
  if (typeof tokens === 'string') return `the query cannot be read: ${tokens}`
  // One trailing semicolon is tolerated; any other one starts a second statement.
  const last = tokens.at(-1)
  const body = last?.kind === 'punct' && last.text === ';' ? tokens.slice(0, -1) : tokens
  if (body.some((t) => t.kind === 'punct' && t.text === ';')) return 'only one statement is allowed'
  const first = body[0]
  if (!first || first.kind !== 'word' || (first.text !== 'select' && first.text !== 'with')) return 'only SELECT or WITH queries are allowed'
  const hidden = deniedTables(tables)
  for (let k = 0; k < body.length; k++) {
    const t = body[k]!
    // A string that names a hidden table is refused wherever it is: SQLite takes `FROM 'kv_state'`
    // and `main.'kv_state'` as names (a literal 'kv_state' in a WHERE is refused too).
    if (t.kind === 'string') {
      if (hidden.has(t.text)) return `"${t.text}" cannot be read here; the tables are: ${ANALYTICS_TABLES.join(', ')}`
      continue
    }
    if (t.kind !== 'word' && t.kind !== 'name') continue
    const next = body[k + 1]
    const call = next?.kind === 'punct' && next.text === '('
    if (t.kind === 'word' && DENIED_KEYWORDS.has(t.text)) return `"${t.text.toUpperCase()}" is not allowed: the endpoint is read-only (quote it if it is a name: "${t.text}")`
    // REPLACE is a statement (REPLACE INTO) and a string function (replace(x, y, z)): only the call is allowed.
    if (t.kind === 'word' && t.text === 'replace' && !call) return '"REPLACE" is not allowed here: only the function replace(x, y, z) (quote it if it is a name: "replace")'
    if ((t.text === 'temp' || t.text === 'temporary') && next?.kind === 'punct' && next.text === '.') return 'only the main database can be read'
    if (hidden.has(t.text)) return `"${t.text}" cannot be read here; the tables are: ${ANALYTICS_TABLES.join(', ')}`
    if (t.text.startsWith('pragma_')) return `"${t.text}" is not allowed: no PRAGMA functions`
    if (call && DENIED_FUNCTION_SET.has(t.text)) return `the function ${t.text}() is not allowed`
  }
  return null
}

/** Names a query may not read: the file's tables and views off `READABLE_TABLES`, and `DENIED_NAMES`. */
export function deniedTables(tables: readonly string[]): Set<string> {
  const readable = new Set(READABLE_TABLES)
  return new Set([...tables.map((t) => t.toLowerCase()).filter((t) => !readable.has(t)), ...DENIED_NAMES])
}

export type QueryParams = (string | number | null)[] | Record<string, string | number | null>

/** Bound values, checked: at most `QUERY_LIMITS.params` strings, finite numbers or nulls; a string when they are not. */
export function checkQueryParams(params: unknown): QueryParams | string {
  if (params === undefined || params === null) return []
  const ok = (v: unknown) => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
  if (Array.isArray(params)) {
    if (params.length > QUERY_LIMITS.params) return `at most ${QUERY_LIMITS.params} params`
    return params.every(ok) ? (params as (string | number | null)[]) : '"params" values must be strings, numbers or null'
  }
  if (typeof params === 'object') {
    const entries = Object.entries(params as Record<string, unknown>)
    if (entries.length > QUERY_LIMITS.params) return `at most ${QUERY_LIMITS.params} params`
    if (!entries.every(([k, v]) => /^\w{1,64}$/.test(k) && ok(v))) return '"params" names must be words and values strings, numbers or null'
    return params as Record<string, string | number | null>
  }
  return '"params" must be an array or an object of named values'
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  /** There were more rows than `limit`, or the query was stopped (`timedOut`): the rows are not all of them. */
  truncated: boolean
  /** The query outlived the time budget and was stopped: no rows. */
  timedOut: boolean
  elapsedMs: number
}

/** A query the check refused (a 400), apart from SQLite's own errors. */
export class QueryRefused extends Error {}
