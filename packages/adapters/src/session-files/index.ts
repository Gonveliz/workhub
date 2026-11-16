/**
 * The files of a session's folder, for the composer's `@` mentions. In a Git repository: the
 * tracked files and the untracked ones that are not ignored, from the hardened git runner (it never
 * runs hooks or repository-configured programs). Anywhere else: a bounded walk that skips dot
 * folders and `node_modules`. Paths are relative to the folder, with `/`.
 */
import { readdir } from 'node:fs/promises'
import { runGit, type GitRunner } from '../git-review'

/** Most paths one listing returns; a bigger repository is cut, and the result says so. */
export const SESSION_FILES_CAP = 20_000
/** The walk of a folder that is not a repository looks at fewer paths and not too deep. */
const WALK_CAP = 5_000
const WALK_DEPTH = 8

export interface SessionFiles {
  files: string[]
  /** The listing stopped at the cap. */
  truncated: boolean
}

async function walk(root: string, cap: number): Promise<SessionFiles> {
  const files: string[] = []
  let queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: '', depth: 0 }]
  // Breadth first: when the cap cuts the walk, the shallow files are the ones kept.
  while (queue.length > 0 && files.length < cap) {
    const next: typeof queue = []
    for (const { dir, rel, depth } of queue) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && depth < WALK_DEPTH) next.push({ dir: `${dir}/${e.name}`, rel: `${rel}${e.name}/`, depth: depth + 1 })
        } else if (e.isFile()) {
          if (files.length >= cap) return { files, truncated: true }
          files.push(rel + e.name)
        }
      }
    }
    queue = next
  }
  return { files, truncated: queue.length > 0 }
}

export async function listSessionFiles(cwd: string, git: GitRunner = runGit, cap = SESSION_FILES_CAP): Promise<SessionFiles> {
  const r = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: 15_000, maxBuffer: 64 * 1024 * 1024 })
  if (!r.ok) return walk(cwd, Math.min(cap, WALK_CAP))
  // A path can be listed twice (a file in conflict); a submodule shows as its folder, which is not a file to mention.
  const files = [...new Set(r.stdout.split('\0').filter(Boolean))]
  return files.length > cap ? { files: files.slice(0, cap), truncated: true } : { files, truncated: false }
}
