import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { filePreview, PREVIEW_TEXT_MAX_BYTES } from '../src/web/file-preview'
import { FilePreviewBody } from '../src/web/screens/SessionScreen'
import type { RemoteFile } from '../src/shared/remote-api'

const file = (name: string, mime: string, content: string | Uint8Array): RemoteFile => {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
  return { name, size: bytes.length, mime, data: bytes.toString('base64') }
}
const body = (f: RemoteFile, expanded = false) => renderToStaticMarkup(createElement(FilePreviewBody, { file: f, preview: filePreview(f), expanded }))

describe('what the phone shows of a fetched file', () => {
  it('renders a Markdown document and shows any other text as it is', () => {
    expect(filePreview(file('notes.md', 'text/markdown', '# Título\n\n- uno'))).toEqual({ kind: 'markdown', text: '# Título\n\n- uno' })
    expect(filePreview(file('run.log', 'text/plain', 'line 1\nline 2'))).toEqual({ kind: 'text', text: 'line 1\nline 2' })
    expect(filePreview(file('data.json', 'application/json', '{"a":1}'))).toEqual({ kind: 'text', text: '{"a":1}' })
  })

  it('judges text by the content, so a file with an unknown extension previews too', () => {
    expect(filePreview(file('App.tsx', 'application/octet-stream', 'export const a = 1\n'))).toEqual({ kind: 'text', text: 'export const a = 1\n' })
    expect(filePreview(file('page.html', 'text/html', '<script>alert(1)</script>'))).toEqual({ kind: 'text', text: '<script>alert(1)</script>' })
  })

  it('only downloads a binary, a PDF and an SVG', () => {
    expect(filePreview(file('app.bin', 'application/octet-stream', new Uint8Array([1, 0, 2, 3])))).toBeNull()
    expect(filePreview(file('bad.txt', 'text/plain', new Uint8Array([0xff, 0xfe, 0x41])))).toBeNull()
    expect(filePreview(file('doc.pdf', 'application/pdf', '%PDF-1.7'))).toBeNull()
    expect(filePreview(file('logo.svg', 'image/svg+xml', '<svg/>'))).toBeNull()
    expect(filePreview({ name: 'x.txt', size: 3, mime: 'text/plain', data: '***' })).toBeNull()
  })

  it('draws the images it always drew', () => {
    expect(filePreview(file('shot.png', 'image/png', new Uint8Array([137, 80, 78, 71])))).toEqual({ kind: 'image' })
  })

  it('says a long text is too long instead of filling the chat, and stays quiet for a long binary', () => {
    const long = 'é'.repeat(PREVIEW_TEXT_MAX_BYTES)
    expect(filePreview(file('big.log', 'text/plain', long))).toEqual({ kind: 'tooLong' })
    expect(filePreview(file('big.bin', 'application/octet-stream', new Uint8Array(PREVIEW_TEXT_MAX_BYTES + 1)))).toBeNull()
    expect(filePreview(file('edge.txt', 'text/plain', 'a'.repeat(PREVIEW_TEXT_MAX_BYTES)))).toMatchObject({ kind: 'text' })
  })
})

describe('the file preview in the phone chat', () => {
  it('shows a Markdown file formatted, in a box that scrolls until it is expanded', () => {
    const md = file('notes.md', 'text/markdown', '# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>')
    const html = body(md)
    expect(html).toContain('data-testid="file-preview-markdown"')
    expect(html).toContain('<h1')
    expect(html).toContain('<table')
    expect(html).not.toContain('<script')
    expect(html).toContain('max-h-80')
    expect(body(md, true)).not.toContain('max-h-80')
  })

  it('shows other text escaped, never as markup', () => {
    const html = body(file('page.html', 'text/html', '<b>bold</b>'))
    expect(html).toContain('data-testid="file-preview-text"')
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
  })

  it('explains a text that is too long and shows nothing for a file that only downloads', () => {
    expect(body(file('big.log', 'text/plain', 'x'.repeat(PREVIEW_TEXT_MAX_BYTES + 1)))).toContain('Too long to show here')
    expect(body(file('doc.pdf', 'application/pdf', '%PDF-1.7'))).toBe('')
    expect(body(file('shot.png', 'image/png', new Uint8Array([137, 80])))).toContain('<img')
  })
})
