// The Changes screen's lists, grown a page at a time: changed files and the pieces of one file's
// diff. A page can repeat rows when the list moved between reads; each row is kept once.
import type { RemoteChangedFile, RemoteDiffPiece } from '../shared/remote-changes-api'

export const fileKey = (f: Pick<RemoteChangedFile, 'repo' | 'path'>): string => `${f.repo}\0${f.path}`
export const pieceKey = (p: Pick<RemoteDiffPiece, 'hunk' | 'start'>): string => `${p.hunk}:${p.start}`

function addOnce<T>(have: readonly T[], rows: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set(have.map(keyOf))
  const out = [...have]
  for (const row of rows) {
    const key = keyOf(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

export const addFiles = (have: readonly RemoteChangedFile[], rows: readonly RemoteChangedFile[]): RemoteChangedFile[] => addOnce(have, rows, fileKey)
export const addPieces = (have: readonly RemoteDiffPiece[], rows: readonly RemoteDiffPiece[]): RemoteDiffPiece[] => addOnce(have, rows, pieceKey)
