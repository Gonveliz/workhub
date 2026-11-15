import { Plus, Tag, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import type { MessageKey } from '../../i18n/translate'

/** The most tags a session keeps (main refuses more). */
export const MAX_TAGS = 20
/** The longest tag main accepts. */
export const MAX_TAG_LENGTH = 40

/** As main stores a tag: trimmed, inner spaces folded, lower case, at most `MAX_TAG_LENGTH` characters. */
export function normalizeTagInput(tag: string): string {
  return tag.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LENGTH)
}

/** The tags after adding `input` (comma separated adds several), deduplicated, in the order given, never past `MAX_TAGS`. */
export function addTags(tags: readonly string[], input: string): string[] {
  const added = input.split(',').map(normalizeTagInput).filter(Boolean)
  return [...new Set([...tags, ...added])].slice(0, Math.max(tags.length, MAX_TAGS))
}

/** The field's text with each comma-separated tag held to `MAX_TAG_LENGTH` (a pasted list keeps every tag). */
export function capTagDraft(draft: string): string {
  return draft
    .split(',')
    .map((part) => {
      const lead = /^\s*/.exec(part)![0]
      return lead + part.slice(lead.length, lead.length + MAX_TAG_LENGTH)
    })
    .join(',')
}

/** What to tell the person when main refuses the tags (its message goes to the console only). */
export function tagsErrorKey(e: unknown): MessageKey {
  const message = errorText(e)
  if (message.includes('tags must be a list of strings')) return 'tags.error.invalid'
  if (message.includes('a session id is required')) return 'tags.error.noSession'
  return 'tags.error.failed'
}

/**
 * A session's free tags as chips: × removes one, the field adds one (Return or comma). Saved at
 * once through `analytics:setTags`, by the session's identity (the agent's session id). `tags`
 * seeds the chips when the caller already has them; otherwise they are read.
 */
export function TagsEditor({ sessionId, tags: initial, onChange, compact = false, className }: { sessionId: string; tags?: string[]; onChange?: (tags: string[]) => void; compact?: boolean; className?: string }) {
  const { t } = useI18n()
  const [tags, setTags] = useState<string[]>(initial ?? [])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // Saves run one after another, each from the tags the previous one stored.
  const current = useRef(tags)
  current.current = tags
  const queue = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    if (initial) {
      setTags(initial)
      return
    }
    let alive = true
    void window.hub.analytics.tags(sessionId).then(
      (list) => alive && setTags(list),
      () => undefined
    )
    return () => {
      alive = false
    }
    // Seeded tags are compared by value: a new array with the same tags is no change.
  }, [sessionId, initial?.join('\n')])

  const save = (edit: (tags: string[]) => string[]) => {
    queue.current = queue.current.then(async () => {
      const before = current.current
      const next = edit(before)
      if (next.length === before.length && next.every((x, i) => x === before[i])) return
      setError('')
      setSaving(true)
      current.current = next
      setTags(next)
      try {
        const stored = await window.hub.analytics.setTags(sessionId, next)
        current.current = stored
        setTags(stored)
        onChange?.(stored)
      } catch (e) {
        current.current = before
        setTags(before)
        console.warn('[tags] could not save', errorText(e))
        setError(t(tagsErrorKey(e)))
      } finally {
        setSaving(false)
      }
    })
  }
  const full = tags.length >= MAX_TAGS
  const add = () => {
    const input = draft
    setDraft('')
    if (input.trim()) save((list) => addTags(list, input))
  }

  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid="tags-editor">
      <ul className="flex flex-wrap items-center gap-1" aria-label={t('tags.label')}>
        {tags.map((tag) => (
          <li key={tag} className="inline-flex h-5 items-center gap-0.5 rounded-full bg-accent-soft pr-0.5 pl-2 text-xs text-text">
            <span className="max-w-40 truncate">{tag}</span>
            <button
              type="button"
              aria-label={t('tags.remove', { tag })}
              title={t('tags.remove', { tag })}
              disabled={saving}
              onClick={() => save((list) => list.filter((x) => x !== tag))}
              className="rounded-full p-0.5 text-muted hover:bg-surface-hover hover:text-text"
            >
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
        <li className="inline-flex items-center">
          <label className={cn('inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-1.5 text-xs text-muted focus-within:border-accent', compact ? 'w-40' : 'w-44')}>
            {tags.length === 0 ? <Tag className="size-3 shrink-0" aria-hidden /> : <Plus className="size-3 shrink-0" aria-hidden />}
            <input
              value={draft}
              onChange={(e) => setDraft(capTagDraft(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  add()
                }
              }}
              onBlur={() => draft.trim() && add()}
              placeholder={full ? t('tags.full', { max: MAX_TAGS }) : t('tags.add')}
              aria-label={t('tags.add')}
              disabled={full}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-subtle"
            />
          </label>
        </li>
      </ul>
      {full && <p className="text-xs text-subtle">{t('tags.fullHint', { max: MAX_TAGS })}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
