/** A fence line: its run of backticks or tildes and what follows it (the info string, or nothing on a closing line). */
const FENCE = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/
/** A list item's first line, at the left margin: a blank line before it may continue the list above (a loose list). */
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
/**
 * What makes blocks depend on each other: link reference and footnote definitions (used anywhere in
 * the text) and the HTML blocks that run across blank lines (comments, `<pre>`, `<script>`...).
 */
const WHOLE_TEXT = /^ {0,3}(?:\[[^\]]+\]:|<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[))/im

/**
 * Splits Markdown into top-level blocks that render the same one by one as the whole text does
 * (joined by a line break): a streaming reply then parses only its last block again, not all of it.
 *
 * A block ends at a blank line followed by a line at the left margin that is not a list item. It
 * never ends inside a fenced code block. Anything this cannot tell for sure (a fence opened inside
 * a list, definitions shared across the text) keeps the rest in one block: fewer blocks, never a
 * different rendering. Joining the blocks with `\n` gives the text back.
 */
export function markdownBlocks(text: string): string[] {
  if (WHOLE_TEXT.test(text)) return [text]
  const lines = text.split('\n')
  const blocks: string[] = []
  let start = 0
  let fence: { char: string; length: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = FENCE.exec(line)
    if (fence) {
      if (m && m[2]![0] === fence.char && m[2]!.length >= fence.length && m[3]!.trim() === '') fence = null
      continue
    }
    if (i > start && lines[i - 1]!.trim() === '' && /^\S/.test(line) && !LIST_ITEM.test(line)) {
      blocks.push(lines.slice(start, i).join('\n'))
      start = i
    }
    if (!m || (m[2]![0] === '`' && m[3]!.includes('`'))) continue
    // A fence at the left margin is always top-level. An indented one may belong to a list item,
    // whose end this does not follow: the rest stays one block.
    if (m[1]) break
    fence = { char: m[2]![0]!, length: m[2]!.length }
  }
  blocks.push(lines.slice(start).join('\n'))
  return blocks
}
