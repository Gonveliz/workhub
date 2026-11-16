import { describe, expect, it } from 'vitest'
import { redactConfig, redactText } from '../src/redact'

describe('redactText', () => {
  it('masks API keys, bearer tokens, key= and token= values and long blobs', () => {
    expect(redactText('using sk-ant-api03-abcdefghijklmnop now')).toBe('using [redacted] now')
    expect(redactText('Authorization: Bearer abc.def-ghi_jkl')).toBe('Authorization: [redacted]')
    expect(redactText('GET /x?api_key=hunter2hunter2&page=2')).toBe('GET /x?api_key=[redacted]&page=2')
    expect(redactText('ANTHROPIC_AUTH_TOKEN="abc def" next')).toBe('ANTHROPIC_AUTH_TOKEN=[redacted] next')
    expect(redactText('{"password": "p@ss w0rd"}')).toBe('{"password": [redacted]}')
    expect(redactText(`blob ${'Ab1+'.repeat(20)}==`)).toBe('blob [redacted]')
    expect(redactText('clone https://user:secret@example.com/a.git')).toBe('clone https://[redacted]@example.com/a.git')
    expect(redactText('ghp_' + 'a'.repeat(30))).toBe('[redacted]')
  })

  it('leaves normal text alone and cuts to the width', () => {
    const normal = 'Error: ENOENT: no such file or directory, open config.json (exit code 1)'
    expect(redactText(normal)).toBe(normal)
    expect(redactText('the key is missing, press a key to continue')).toBe('the key is missing, press a key to continue')
    expect(redactText('x'.repeat(10), 4)).toBe('xxxx…')
    expect(redactText('word '.repeat(100), Infinity)).toHaveLength(500)
  })
})

describe('redactConfig', () => {
  it('masks secret-like values, env maps and paths, and keeps the shape', () => {
    const out = redactConfig({
      version: 3,
      theme: 'dark',
      profiles: [{ id: 'p1', name: 'Acme', workspaceRoots: ['/home/ann/code'], cwd: '~/code', apiKey: 'abc', env: { FOO: 'bar', EMPTY: '' }, note: 'see /home/ann/x for more', n: 2, on: true }],
      command: 'C:\\Tools\\agent.exe',
      url: 'https://example.com/path'
    })
    expect(out).toEqual({
      version: 3,
      theme: 'dark',
      profiles: [{ id: 'p1', name: 'Acme', workspaceRoots: ['[path]'], cwd: '[path]', apiKey: '[redacted]', env: { FOO: '[redacted]', EMPTY: '' }, note: 'see [path] for more', n: 2, on: true }],
      command: '[path]',
      url: 'https://example.com/path'
    })
  })
})
