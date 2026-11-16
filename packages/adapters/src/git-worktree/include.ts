/**
 * `.worktreeinclude`: a new session worktree starts without the git-ignored files a project needs
 * to run (`.env`, local config). When the main checkout has a `.worktreeinclude` (gitignore-style
 * patterns), the files it lists that git ignores are copied to the same place in the worktree.
 *
 * Git does the pattern matching, so negation, `**`, anchoring and directory patterns behave as in a
 * `.gitignore`. A file is copied only when it matches the list AND git ignores it, so a tracked
 * file is never a candidate.
 */
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import type { IncludeCopyResult } from '@workhub/core'
import type { WorktreeGit } from './index'

export const INCLUDE_FILE = '.worktreeinclude'
/** Most files one worktree gets from the list. */
export const MAX_INCLUDE_FILES = 500
/** Most bytes one worktree gets from the list (50 MiB), so a pattern that catches build output cannot fill the disk. */
export const MAX_INCLUDE_BYTES = 50 * 1024 * 1024
/** A longer `.worktreeinclude` is not read. */
const MAX_LIST_BYTES = 64 * 1024
const MAX_SKIPPED_LISTED = 100
const CHUNK = 100

export interface IncludeCaps {
  maxFiles: number
  maxBytes: number
}

/** The patterns that stay inside the repository: no `..` segment, no drive or absolute path outside it. */
export function includePatterns(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const body = line.replace(/^!/, '')
    if (body.split(/[\\/]/).includes('..') || /^[A-Za-z]:/.test(body) || body.startsWith('~') || body.startsWith('\\')) continue
    out.push(line)
  }
  return out
}

const nulList = (out: string): string[] => out.split('\0').filter(Boolean)

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

export async function copyIncludedFiles(git: WorktreeGit, repoRoot: string, worktree: string, caps: IncludeCaps = { maxFiles: MAX_INCLUDE_FILES, maxBytes: MAX_INCLUDE_BYTES }): Promise<IncludeCopyResult> {
  const result: IncludeCopyResult = { copied: [], skipped: [], bytes: 0, found: false }
  const skip = (path: string, reason: IncludeCopyResult['skipped'][number]['reason']) => {
    if (result.skipped.length < MAX_SKIPPED_LISTED) result.skipped.push({ path, reason })
  }
  const listPath = join(repoRoot, INCLUDE_FILE)
  const info = await lstat(listPath).catch(() => null)
  if (!info?.isFile()) return result
  result.found = true
  if (info.size > MAX_LIST_BYTES) throw new Error(`${INCLUDE_FILE} is larger than ${MAX_LIST_BYTES / 1024} KiB`)
  const patterns = includePatterns(await readFile(listPath, 'utf8'))
  if (!patterns.length) return result

  const tmp = await mkdtemp(join(tmpdir(), 'workhub-include-'))
  let candidates: string[]
  const ignored = new Set<string>()
  try {
    const patternFile = join(tmp, 'patterns')
    await writeFile(patternFile, patterns.join('\n') + '\n')
    // Untracked files the list matches (`-o -i` with only this exclude file: the standard ignore rules are not applied).
    const listed = await git(repoRoot, ['--literal-pathspecs', 'ls-files', '-z', '-o', '-i', `--exclude-from=${patternFile}`])
    if (!listed.ok) throw new Error(`git ls-files failed: ${listed.stderr.trim() || 'unknown error'}`)
    candidates = nulList(listed.stdout).sort()
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
  // ...of which git ignores by its own rules (`check-ignore` cannot print NUL-separated paths without stdin).
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const r = await git(repoRoot, ['--literal-pathspecs', 'ls-files', '-z', '-o', '-i', '--exclude-standard', '--', ...candidates.slice(i, i + CHUNK)])
    if (!r.ok) throw new Error(`git ls-files failed: ${r.stderr.trim() || 'unknown error'}`)
    for (const p of nulList(r.stdout)) ignored.add(p)
  }
  const wanted = candidates.filter((p) => ignored.has(p))
  const tracked = new Set<string>()
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const r = await git(worktree, ['--literal-pathspecs', 'ls-files', '-z', '--', ...wanted.slice(i, i + CHUNK)])
    for (const p of nulList(r.stdout)) tracked.add(p)
  }

  const rootReal = await realpath(repoRoot)
  const worktreeReal = await realpath(worktree)
  for (const rel of wanted) {
    const parts = rel.split(/[\\/]/)
    if (isAbsolute(rel) || parts.includes('..') || parts[0] === '.git') {
      skip(rel, 'not-a-file')
      continue
    }
    if (tracked.has(rel)) {
      skip(rel, 'tracked')
      continue
    }
    if (result.copied.length >= caps.maxFiles) {
      skip(rel, 'too-many')
      continue
    }
    try {
      const source = join(repoRoot, rel)
      const link = await lstat(source)
      if (link.isSymbolicLink()) {
        const target = await realpath(source).catch(() => null)
        if (!target || !inside(rootReal, target)) {
          skip(rel, 'symlink-outside')
          continue
        }
      }
      const file = await stat(source)
      if (!file.isFile()) {
        skip(rel, 'not-a-file')
        continue
      }
      if (result.bytes + file.size > caps.maxBytes) {
        skip(rel, 'too-big')
        continue
      }
      const dest = join(worktree, rel)
      await mkdir(dirname(dest), { recursive: true })
      // A tracked symlinked folder in the worktree must not send the copy outside it.
      if (!inside(worktreeReal, await realpath(dirname(dest)))) {
        skip(rel, 'symlink-outside')
        continue
      }
      await copyFile(source, dest, constants.COPYFILE_EXCL).then(
        () => {
          result.copied.push(rel)
          result.bytes += file.size
        },
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'EEXIST') skip(rel, 'exists')
          else throw err
        }
      )
    } catch {
      skip(rel, 'error')
    }
  }
  return result
}
