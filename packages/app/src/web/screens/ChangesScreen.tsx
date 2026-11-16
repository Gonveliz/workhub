import { ChevronLeft, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { LocalReviewScope } from '@workhub/core'
import { Spinner } from '../../renderer/components/atoms'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { useSessions } from '../../renderer/store'
import type { RemoteChangedFile, RemoteChangedRepo, RemoteChangesPage, RemoteDiffPage, RemoteDiffPiece } from '../../shared/remote-changes-api'
import { useClient, useClientStatus } from '../app-context'
import { addFiles, addPieces, fileKey } from '../changes-pages'
import { Body, Header, Screen } from '../ui'
import { ReviewCard, useRemoteReview } from './ReviewCard'
import { sessionTitle } from './HomeScreen'

/** Files asked for per page; a page also stops early to fit the relay's frame. */
const FILES_PAGE = 100
const PIECES_PAGE = 20

const STATUS_TONE: Record<RemoteChangedFile['status'], string> = { added: 'text-success', deleted: 'text-danger', renamed: 'text-info', modified: 'text-warning' }
const STATUS_LETTER: Record<RemoteChangedFile['status'], string> = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' }

type ListState =
  | { state: 'loading' }
  | { state: 'failed'; reason: 'unknownSession' | 'failed' | 'offline' }
  | { state: 'ready'; repos: RemoteChangedRepo[]; files: RemoteChangedFile[]; total: number; cursor: string | null; more: boolean }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One file's diff, a page of hunks at a time; a binary, hidden or too-large file shows why instead. */
function DiffView({ sessionId, scope, file }: { sessionId: string; scope: LocalReviewScope; file: RemoteChangedFile }) {
  const { t, tn } = useI18n()
  const client = useClient()
  const [pieces, setPieces] = useState<RemoteDiffPiece[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<RemoteChangedFile>(file)
  const read = async (after: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const page = (await client.transport.invoke('remote:diff', sessionId, { scope, repo: file.repo, path: file.path, limit: PIECES_PAGE, ...(after ? { cursor: after } : {}) })) as RemoteDiffPage
      setMeta(page.file)
      setPieces((have) => addPieces(after ? have : [], page.pieces.items))
      setCursor(page.pieces.nextCursor)
    } catch (err) {
      setError(t('web.changes.diffFailed', { error: errorText(err) }))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void read(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, scope, file.repo, file.path])
  const note = meta.note
  return (
    <div className="flex flex-col gap-2" data-testid="remote-diff">
      {note && <p className="rounded-lg bg-surface px-3 py-2 text-xs text-muted" data-testid="remote-diff-note">{note === 'hidden' ? t('web.changes.hidden') : t(`localReview.fileNote.${note}`)}</p>}
      {!note && !loading && !error && pieces.length === 0 && <p className="text-xs text-muted">{meta.status === 'deleted' ? t('localReview.deleted') : t('localReview.noDiff')}</p>}
      {pieces.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border bg-bg font-mono text-2xs">
          {pieces.map((p) => (
            <div key={`${p.hunk}:${p.start}`}>
              {p.start === 0 && <div className="bg-surface px-2 py-1 text-info whitespace-pre">{p.header}</div>}
              {p.lines.map((line, i) => (
                <div key={i} className={cn('flex whitespace-pre', line.kind === 'added' && 'bg-success-soft', line.kind === 'removed' && 'bg-danger-soft')}>
                  <span className="w-10 shrink-0 pr-1 text-right text-subtle select-none">{line.kind === 'removed' ? line.oldNumber : line.newNumber}</span>
                  <span className="w-3 shrink-0 select-none text-subtle">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
                  <span className="pr-2">{line.text}</span>
                </div>
              ))}
              {p.cutLines ? <div className="px-2 py-0.5 text-subtle font-sans">{tn('web.changes.cutLines', p.cutLines)}</div> : null}
            </div>
          ))}
        </div>
      )}
      {!cursor && !loading && meta.hiddenLines > 0 && <p className="text-xs text-subtle">{tn('localReview.hiddenLines', meta.hiddenLines)}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
      {loading ? (
        <Spinner className="mx-auto size-4" />
      ) : (
        (cursor || error) && (
          <button type="button" onClick={() => void read(error && !cursor ? null : cursor)} className="mx-auto min-h-9 rounded-full border border-border px-3 text-xs text-muted">
            {error ? t('web.changes.retry') : t('web.changes.loadMore')}
          </button>
        )
      )}
    </div>
  )
}

function FileRow({ file, onOpen }: { file: RemoteChangedFile; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 border-b border-border px-1 py-2.5 text-left text-xs active:bg-surface-hover" data-testid="remote-changed-file">
      <span className={cn('w-4 shrink-0 text-center font-mono font-semibold', STATUS_TONE[file.status])}>{STATUS_LETTER[file.status]}</span>
      <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
        {file.path}
      </span>
      <span className="shrink-0 font-mono tabular-nums text-success">+{file.additions}</span>
      <span className="shrink-0 font-mono tabular-nums text-danger">-{file.deletions}</span>
    </button>
  )
}

/** What a session changed in its repositories, a file's diff, and its review loop. Read only, but for the loop's decisions. */
export function ChangesScreen({ sessionId }: { sessionId: string }) {
  const { t, tn } = useI18n()
  const client = useClient()
  const online = useClientStatus().state === 'online'
  const session = useSessions()[sessionId]
  const [scope, setScope] = useState<LocalReviewScope>('branch')
  const [list, setList] = useState<ListState>({ state: 'loading' })
  const [open, setOpen] = useState<RemoteChangedFile | null>(null)
  const [generation, setGeneration] = useState(0)
  const reading = useRef(0)
  const review = useRemoteReview(sessionId, session?.view.state)

  useEffect(() => {
    if (!online) {
      setList((prev) => (prev.state === 'ready' ? prev : { state: 'failed', reason: 'offline' }))
      return
    }
    const mine = ++reading.current
    setList({ state: 'loading' })
    ;(client.transport.invoke('remote:changes', sessionId, { scope, limit: FILES_PAGE }) as Promise<RemoteChangesPage>).then(
      (page) => {
        if (reading.current !== mine) return
        setList(page.ok ? { state: 'ready', repos: page.repos, files: addFiles([], page.files.items), total: page.files.total, cursor: page.files.nextCursor, more: false } : { state: 'failed', reason: page.reason })
      },
      () => reading.current === mine && setList({ state: 'failed', reason: 'failed' })
    )
  }, [client, sessionId, scope, online, generation])

  const loadMore = async () => {
    if (list.state !== 'ready' || !list.cursor || list.more) return
    const mine = reading.current
    setList({ ...list, more: true })
    try {
      const page = (await client.transport.invoke('remote:changes', sessionId, { scope, limit: FILES_PAGE, cursor: list.cursor })) as RemoteChangesPage
      if (reading.current !== mine) return
      setList((prev) => (prev.state === 'ready' && page.ok ? { ...prev, files: addFiles(prev.files, page.files.items), total: page.files.total, cursor: page.files.nextCursor, more: false } : prev.state === 'ready' ? { ...prev, more: false } : prev))
    } catch {
      setList((prev) => (prev.state === 'ready' ? { ...prev, more: false } : prev))
    }
  }

  const title = session ? sessionTitle(session) : t('web.changes.title')
  if (open) {
    return (
      <Screen>
        <Header
          title={<span className="font-mono text-base">{open.path.split('/').pop()}</span>}
          subtitle={<span className="font-mono">{open.repo} · {open.path}</span>}
          right={
            <button type="button" aria-label={t('web.changes.back')} onClick={() => setOpen(null)} className="flex h-10 items-center gap-1 rounded-lg px-2 text-xs text-muted active:bg-surface-hover">
              <ChevronLeft className="size-4" aria-hidden />
              {t('web.changes.back')}
            </button>
          }
        />
        <Body className="px-3 py-3">
          {open.oldPath && <p className="mb-2 truncate font-mono text-2xs text-subtle">{t('localReview.renamedFrom', { path: open.oldPath })}</p>}
          <DiffView key={fileKey(open)} sessionId={sessionId} scope={scope} file={open} />
        </Body>
      </Screen>
    )
  }

  return (
    <Screen>
      <Header
        title={t('web.changes.title')}
        subtitle={title}
        back={{ screen: 'session', id: sessionId }}
        right={
          <button type="button" aria-label={t('web.changes.refresh')} disabled={!online} onClick={() => { setGeneration((n) => n + 1); review.reload() }} className="flex size-10 items-center justify-center rounded-lg text-muted active:bg-surface-hover disabled:opacity-50">
            <RefreshCw className="size-4.5" aria-hidden />
          </button>
        }
      />
      <Body className="px-4 py-3">
        <div className="flex flex-col gap-3">
          {review.state && <ReviewCard sessionId={sessionId} state={review.state} onDone={review.reload} />}
          <div role="group" aria-label={t('localReview.scope')} className="grid grid-cols-2 gap-1 rounded-xl border border-border p-1 text-xs">
            {(['branch', 'uncommitted'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)} className={cn('h-9 rounded-lg', scope === s ? 'bg-surface-raised font-semibold text-text' : 'text-muted')}>
                {t(`localReview.scope.${s}`)}
              </button>
            ))}
          </div>
          {list.state === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
              <Spinner className="size-4" />
              {t('web.changes.loading')}
            </div>
          )}
          {list.state === 'failed' && (
            <p className="py-6 text-center text-sm text-muted">
              {list.reason === 'unknownSession' ? t('web.session.missing') : list.reason === 'offline' ? t('web.changes.offline') : t('web.changes.failed')}
            </p>
          )}
          {list.state === 'ready' && (
            <>
              {list.repos.map((r) => (
                <div key={r.key} className="text-2xs text-subtle">
                  <span className="font-semibold text-muted">{r.name}</span>
                  {r.branch ? ` · ${r.branch}` : ` · ${t('localReview.detached')}`}
                  {r.base ? ` · ${t('web.changes.against', { base: r.base })}` : ''} · {tn('web.changes.files', r.files)}
                  {r.note && <div className="text-warning">{t(`localReview.repoNote.${r.note}`)}</div>}
                </div>
              ))}
              {list.total === 0 ? (
                <p className="py-6 text-center text-sm text-muted">{scope === 'uncommitted' ? t('localReview.noChangesUncommitted') : t('localReview.noChangesBranch')}</p>
              ) : (
                <div>
                  {list.files.map((f) => (
                    <FileRow key={fileKey(f)} file={f} onOpen={() => setOpen(f)} />
                  ))}
                </div>
              )}
              {list.cursor && (
                <button type="button" onClick={() => void loadMore()} disabled={list.more || !online} className="mx-auto flex min-h-9 items-center gap-2 rounded-full border border-border px-3 text-xs text-muted disabled:opacity-60">
                  {list.more && <Spinner className="size-3.5" />}
                  {t('web.changes.loadMore')}
                </button>
              )}
            </>
          )}
        </div>
      </Body>
    </Screen>
  )
}
