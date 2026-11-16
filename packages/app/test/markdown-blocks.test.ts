import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/renderer/components/molecules/Markdown'
import { markdownBlocks } from '../src/renderer/lib/markdownBlocks'

const html = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], skipHtml: true }, text))
/** What the Markdown component renders: each block on its own, with the line break the whole text has between them. */
const byBlocks = (text: string) => markdownBlocks(text).map(html).join('\n')

const REPLY = [
  '# Plan',
  '',
  'First a paragraph',
  'with two lines.',
  '',
  '- one',
  '- two',
  '',
  '- three, loose',
  '',
  '  still item three',
  '',
  '1. step',
  '',
  '2. step',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const a = 1',
  '',
  'const b = 2',
  '```',
  '',
  '````md',
  '```js',
  'nested',
  '',
  '```',
  '````',
  '',
  '> quoted',
  '',
  '> another quote',
  '',
  '    indented code',
  '',
  '    more code',
  '',
  '---',
  '',
  'The end, with `src/app.ts` and [a link](https://example.com).'
].join('\n')

describe('markdownBlocks', () => {
  it('splits at blank lines before a line at the left margin, and joins back to the text', () => {
    expect(markdownBlocks('one\n\ntwo\n\nthree')).toEqual(['one\n', 'two\n', 'three'])
    expect(markdownBlocks(REPLY).join('\n')).toBe(REPLY)
    expect(markdownBlocks(REPLY).length).toBeGreaterThan(5)
  })

  it('never splits inside a fenced block, nested fences included', () => {
    const code = '```\na\n\nb\n```'
    expect(markdownBlocks(`${code}\n\nafter`)).toEqual([`${code}\n`, 'after'])
    const nested = '````md\n```js\nx\n\ny\n```\n\nz\n````'
    expect(markdownBlocks(`${nested}\n\nafter`)).toEqual([`${nested}\n`, 'after'])
    expect(markdownBlocks('~~~\na\n\n```\n\nb\n~~~\n\nafter')).toEqual(['~~~\na\n\n```\n\nb\n~~~\n', 'after'])
  })

  it('keeps an unfinished fence and everything after it in the last block', () => {
    expect(markdownBlocks('intro\n\n```py\nprint(1)\n\nprint(2)')).toEqual(['intro\n', '```py\nprint(1)\n\nprint(2)'])
  })

  it('keeps lists together across blank lines, and their indented continuations', () => {
    expect(markdownBlocks('- a\n\n- b\n\n  more b\n\n1. c\n\nafter')).toEqual(['- a\n\n- b\n\n  more b\n\n1. c\n', 'after'])
  })

  it('keeps tables whole', () => {
    expect(markdownBlocks('| a |\n| - |\n| 1 |\n\ntext')).toEqual(['| a |\n| - |\n| 1 |\n', 'text'])
  })

  it('keeps the rest whole after a fence inside a list, and the whole text when blocks depend on each other', () => {
    expect(markdownBlocks('intro\n\npara\n1. step\n   ```\n   code\n```\n\nlater\n\nmore')).toEqual(['intro\n', 'para\n1. step\n   ```\n   code\n```\n\nlater\n\nmore'])
    const refs = 'see [docs]\n\nmore\n\n[docs]: https://example.com'
    expect(markdownBlocks(refs)).toEqual([refs])
    const comment = '<!--\n\nhidden\n\n-->\n\ntext'
    expect(markdownBlocks(comment)).toEqual([comment])
  })

  const samples = {
    reply: REPLY,
    listFence: '1. step\n   ```\n   code\n```\n\nlater\n\n```\nopen',
    footnotes: 'text[^1]\n\nmore\n\n[^1]: the note',
    html: '<div>\n\n**bold**\n\n</div>\n\n<!-- c\n\nd -->\n\ne',
    breaks: 'a\n\n\n\nb\n\n  \n\n* * *\n\n+ x\n\n10) y\n\nz',
    setext: 'Title\n=====\n\n---\n\npara\n\n===',
    listCode: '1. a\n\n   ```sh\n   npm test\n\n   more\n   ```\n\n2. b\n\nafter\n\n```\nx\n```\n\nend',
    tabs: '\tcode\n\ntext\n\n-\ttab item\n\n-\tsecond\n\nlast',
    crlf: 'one\r\n\r\ntwo\r\n\r\n```\r\nx\r\n\r\n```'
  }

  it('renders the same as the whole text, at every point of a streaming reply', () => {
    for (const [name, text] of Object.entries(samples))
      for (let n = 1; n <= text.length; n++) {
        const prefix = text.slice(0, n)
        expect(byBlocks(prefix), `${name} at ${n}`).toBe(html(prefix))
      }
  })

  it('leaves finished blocks unchanged as the reply grows, so only the last one parses again', () => {
    const before = markdownBlocks(REPLY.slice(0, REPLY.indexOf('> quoted') + 4))
    const after = markdownBlocks(REPLY)
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1))
  })
})

it('the Markdown component renders the blocks as one text', () => {
  const text = '# Title\n\nOne *two*\n\n- a\n\n- b\n\n> quote\n\n| a |\n| - |\n| 1 |\n\nend'
  expect(renderToStaticMarkup(createElement(Markdown, { text }))).toBe(`<div class="markdown min-w-0 break-words">${html(text)}</div>`)
})
