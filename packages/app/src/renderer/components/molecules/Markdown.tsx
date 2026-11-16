import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Play } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { filePathIn, isShellLanguage, shellCommandOf } from '../../lib/chatLinks'
import { cn } from '../../lib/cn'
import { markdownBlocks } from '../../lib/markdownBlocks'
import { useI18n } from '../../i18n/I18nProvider'
import { IconButton } from '../atoms'
import { CopyButton } from './CopyButton'

/** Only web and mail links open (in the default browser); anything else stays plain text. */
export function safeHref(href: string | undefined): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null
  } catch {
    return null
  }
}

/** What a reply's files and commands do when clicked (an agent's reply in a session); none elsewhere. */
export interface MarkdownActions {
  /** Opens a file the text names (a path in inline code or a link), relative to the session folder. */
  openFile(path: string): void
  /** Runs a shell block's command; absent when the session has no shell. */
  runCommand?(command: string): void
  /**
   * Whether a path that looks like a file is one: only those become links. `known` answers at once
   * when it can. Without it, every path that looks like a file is a link.
   */
  isFile?: { known(path: string): boolean | undefined; check(path: string): Promise<boolean> }
}

/** A path the text names, once known to be a file (when the actions can check); null otherwise. */
function useFilePath(actions: MarkdownActions | null, path: string | null): string | null {
  const [checked, setChecked] = useState<boolean | undefined>(() => (path && actions?.isFile ? actions.isFile.known(path) : undefined))
  useEffect(() => {
    if (!path || !actions?.isFile || checked !== undefined) return
    let live = true
    void actions.isFile.check(path).then((file) => live && setChecked(file))
    return () => {
      live = false
    }
  }, [actions, path, checked])
  if (!path || !actions) return null
  return !actions.isFile || checked === true ? path : null
}

const ActionsContext = createContext<MarkdownActions | null>(null)
/** Set inside fenced blocks: code there is a block, not a path to open. */
const InBlockContext = createContext(false)

/** Inline code that names a file opens it; any other code renders as usual. */
function InlineCode({ className, children }: { className?: string; children?: ReactNode }) {
  const actions = useContext(ActionsContext)
  const inBlock = useContext(InBlockContext)
  const { t } = useI18n()
  const path = useFilePath(actions, actions && !inBlock && typeof children === 'string' ? filePathIn(children) : null)
  if (!path) return <code className={className}>{children}</code>
  return (
    <button type="button" className="cursor-pointer text-accent hover:underline" title={t('chat.openFile', { path })} onClick={() => actions!.openFile(path)}>
      <code className={className}>{children}</code>
    </button>
  )
}

/** The renderers of a text whose links open the way `profileId` opens links (its browser), or the default one. */
const componentsFor = (profileId: string | null | undefined): Components => ({
  a: ({ href, children }) => {
    const target = safeHref(href)
    if (!target) return <FileLink href={href}>{children}</FileLink>
    return (
      <a
        href={target}
        title={target}
        onClick={(e) => {
          e.preventDefault()
          window.hub.openExternal(target, profileId)
        }}
      >
        {children}
      </a>
    )
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => <InlineCode className={className}>{children}</InlineCode>,
  // Images in a reply would load remote content; show their alt text and address instead.
  img: ({ alt, src }) => <span className="text-muted">{alt || (typeof src === 'string' ? src : '')}</span>
})

const COMPONENTS = componentsFor(null)

/** A link whose target is a file path (`[notes](docs/notes.md)`): it opens the file when the text can; plain text otherwise. */
function FileLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const actions = useContext(ActionsContext)
  const { t } = useI18n()
  const path = useFilePath(actions, actions && href && !/^[a-z][\w+.-]*:/i.test(href) ? filePathIn(safeDecode(href)) : null)
  if (!path) return <span>{children}</span>
  return (
    <button type="button" className="cursor-pointer text-accent hover:underline" title={t('chat.openFile', { path })} onClick={() => actions!.openFile(path)}>
      {children}
    </button>
  )
}

function safeDecode(href: string): string {
  try {
    return decodeURI(href)
  } catch {
    return href
  }
}

/** The language class of a fenced block's `<code>` child (`language-bash`). */
function languageOf(children: ReactNode): string | undefined {
  const child = Array.isArray(children) ? children[0] : children
  return child && typeof child === 'object' && 'props' in child ? (child.props as { className?: string }).className : undefined
}

/** A fenced code block with its own copy button in the corner, and a run button for shell blocks. */
function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const actions = useContext(ActionsContext)
  const { t } = useI18n()
  const run = actions?.runCommand && isShellLanguage(languageOf(children)) ? actions.runCommand : undefined
  return (
    <div className="group/code relative max-w-full min-w-0">
      <InBlockContext.Provider value={true}>
        <pre ref={ref}>{children}</pre>
      </InBlockContext.Provider>
      <div className="absolute top-1 right-1 flex gap-1">
        {run && (
          <IconButton
            size="sm"
            label={t('chat.runCommand')}
            className="size-6 bg-surface/80 opacity-70 group-hover/code:opacity-100"
            icon={<Play className="size-3.5" aria-hidden />}
            onClick={() => {
              const command = shellCommandOf(ref.current?.innerText ?? '')
              if (command) run(command)
            }}
          />
        )}
        <CopyButton text={() => ref.current?.innerText ?? ''} className="bg-surface/80 opacity-70 group-hover/code:opacity-100" />
      </div>
    </div>
  )
}

/**
 * An agent's reply as Markdown: GitHub tables, code blocks and links. Raw HTML in the text is
 * dropped (`skipHtml`), never rendered; images show as text. `profileId` opens links in that
 * profile's browser.
 */
/**
 * Keeps single line breaks as breaks (plain notes and alert details are written line by line),
 * outside fenced code blocks. Markdown alone would join those lines into one paragraph.
 */
export function hardBreaks(text: string): string {
  let fenced = false
  return text
    .split('\n')
    .map((line, i, lines) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      const next = lines[i + 1]
      const joinsNext = !fenced && line.trim() !== '' && next !== undefined && next.trim() !== '' && !/^\s*(```|~~~)/.test(next)
      return joinsNext && !line.endsWith('  ') ? `${line}  ` : line
    })
    .join('\n')
}

const REMARK_PLUGINS = [remarkGfm]

/** One top-level block of a text, parsed again only when its own text changes. */
const MarkdownBlock = memo(function MarkdownBlock({ text, components }: { text: string; components: Components }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} skipHtml components={components}>
      {text}
    </ReactMarkdown>
  )
})

/**
 * The text renders block by block (see `markdownBlocks`), with the line break the whole text would
 * have between them: while a reply streams, the blocks it already finished keep their parse.
 */
export const Markdown = memo(function Markdown({ text, className, profileId, breaks, actions }: { text: string; className?: string; profileId?: string | null; breaks?: boolean; actions?: MarkdownActions }) {
  const components = useMemo(() => (profileId ? componentsFor(profileId) : COMPONENTS), [profileId])
  const source = breaks ? hardBreaks(text) : text
  const blocks = useMemo(() => markdownBlocks(source), [source])
  return (
    <ActionsContext.Provider value={actions ?? null}>
      <div className={cn('markdown min-w-0 break-words', className)}>
        {blocks.map((block, i) => (
          <Fragment key={i}>
            {i > 0 && '\n'}
            <MarkdownBlock text={block} components={components} />
          </Fragment>
        ))}
      </div>
    </ActionsContext.Provider>
  )
})
