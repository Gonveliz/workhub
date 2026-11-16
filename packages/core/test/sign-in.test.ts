import { describe, expect, it } from 'vitest'
import { isSignInTool, parseSignInPrompt, plainTerminalText, SIGN_IN_COMMANDS, SIGN_IN_TOOLS, signInReady } from '../src/setup/sign-in'

const ESC = '\x1b'

describe('sign-in tools', () => {
  it('accepts only the fixed list', () => {
    expect([...SIGN_IN_TOOLS]).toEqual(['claude', 'codex', 'kiro', 'github', 'gitlab'])
    for (const tool of SIGN_IN_TOOLS) expect(isSignInTool(tool)).toBe(true)
    for (const other of ['shell', 'bash', 'claude auth login', 'CLAUDE', '', 'constructor', '__proto__', 'toString', null, undefined, 1, {}, ['claude']]) {
      expect(isSignInTool(other)).toBe(false)
    }
  })

  it('every tool has its own command and status check, never a shell', () => {
    for (const tool of SIGN_IN_TOOLS) {
      const c = SIGN_IN_COMMANDS[tool]
      expect(c.command).toMatch(/^[a-z-]+$/)
      expect(['sh', 'bash', 'zsh', 'cmd', 'powershell']).not.toContain(c.command)
      expect(c.status.command).toBe(c.command)
    }
    expect(SIGN_IN_COMMANDS.claude).toMatchObject({ command: 'claude', args: ['auth', 'login'] })
    expect(SIGN_IN_COMMANDS.github.args).toContain('--web')
    expect(SIGN_IN_COMMANDS.gitlab.args).toContain('--web')
  })
})

describe('parseSignInPrompt', () => {
  it('GitHub CLI: code and address, with colors', () => {
    const out = `${ESC}[0;33m!${ESC}[0m First copy your one-time code: ${ESC}[1mAB12-CD34${ESC}[0m\r\n${ESC}[1mPress Enter${ESC}[0m to open https://github.com/login/device in your browser... `
    expect(parseSignInPrompt(out)).toEqual({ code: 'AB12-CD34', url: 'https://github.com/login/device' })
  })

  it('GitHub CLI: a code without a full address leaves the address to the tool table', () => {
    expect(parseSignInPrompt('! First copy your one-time code: AB12-CD34\nPress Enter to open github.com in your browser... ')).toEqual({ code: 'AB12-CD34', url: null })
    // A long address is one line in what the tool prints, however the terminal wraps it; escapes
    // of the kitty keyboard protocol (glab) are not text.
    const long = `https://auth.example.com/oauth/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=${'s'.repeat(300)}`
    expect(parseSignInPrompt(`${ESC}[>4;2m${ESC}[>1uIf your browser did not open, navigate to this URL to authenticate:\r\n\r\n${long}\r\n\r\nOn a remote machine? Use another flow.`)).toEqual({ code: null, url: long })
    // gh 2.104 words it differently and copies the code itself.
    expect(parseSignInPrompt('! One-time code (AB12-CD34) copied to clipboard\nPress Enter to open https://github.com/login/device in your browser... ')).toEqual({ code: 'AB12-CD34', url: 'https://github.com/login/device' })
  })

  it('Codex device flow: the code is on the line after its label', () => {
    const out = [
      'Welcome to Codex',
      '',
      '1. Open this link in your browser and sign in to your account',
      `   ${ESC}[94mhttps://auth.example.com/codex/device${ESC}[0m`,
      '',
      `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`,
      `   ${ESC}[94mWXYZ-98765${ESC}[0m`
    ].join('\n')
    expect(parseSignInPrompt(out)).toEqual({ url: 'https://auth.example.com/codex/device', code: 'WXYZ-98765' })
  })

  it('browser flows: the address to open, never the local callback server', () => {
    const codex = [
      'Starting local login server on http://localhost:1455.',
      'If your browser did not open, navigate to this URL to authenticate:',
      '',
      'https://auth.example.com/oauth/authorize?response_type=code&client_id=app_1&state=xyz'
    ].join('\n')
    expect(parseSignInPrompt(codex)).toEqual({ url: 'https://auth.example.com/oauth/authorize?response_type=code&client_id=app_1&state=xyz', code: null })
    expect(parseSignInPrompt('Listening on http://127.0.0.1:7171/auth/redirect').url).toBeNull()
    // Claude Code: an address to visit when the browser did not open.
    expect(parseSignInPrompt('Browser didn\'t open? Use the url below to sign in:\r\n\r\nhttps://login.example.com/oauth/authorize?code=true&state=abc\r\n').url).toBe('https://login.example.com/oauth/authorize?code=true&state=abc')
  })

  it('AWS-style device flow (Kiro): code label and a verification address carrying the code', () => {
    expect(parseSignInPrompt('Confirm the following code in the browser\nCode: QWER-TYUI\n\nOpen this URL: https://device.example.com/start/#/device?user_code=QWER-TYUI')).toEqual({
      code: 'QWER-TYUI',
      url: 'https://device.example.com/start/#/device?user_code=QWER-TYUI'
    })
    expect(parseSignInPrompt('Open this URL: https://device.example.com/start/#/device?user_code=ZXCV-BNMA').code).toBe('ZXCV-BNMA')
  })

  it('trims trailing punctuation and keeps the newest address and code', () => {
    expect(parseSignInPrompt('Visit (https://a.example.com/x).').url).toBe('https://a.example.com/x')
    expect(parseSignInPrompt('one-time code: AAAA-1111 at https://a.example.com\nexpired; one-time code: BBBB-2222 at https://b.example.com')).toEqual({ code: 'BBBB-2222', url: 'https://b.example.com' })
  })

  it('no false match on ordinary text', () => {
    for (const text of [
      'Signing in…',
      'exit code: 1',
      'Error code: 404 Not Found',
      'The code: abcd-efgh is lower case',
      'Your code is ready. Run code-review to check it.',
      'version 2.1.4-beta',
      'Fetched 2026-11-16 from the cache',
      'see ftp://files.example.com/x or file:///tmp/x or javascript:alert(1)',
      'mailto:someone@example.com'
    ]) {
      expect(parseSignInPrompt(text), text).toEqual({ url: null, code: null })
    }
  })

  it('reads OSC 8 hyperlinks and titles as plain text', () => {
    const out = `${ESC}]0;title${ESC}\\${ESC}]8;;https://a.example.com/x${ESC}\\open${ESC}]8;;${ESC}\\`
    expect(plainTerminalText(out)).toBe('open')
    expect(parseSignInPrompt(out).url).toBeNull()
  })
})

describe('signInReady', () => {
  it('reads Claude\'s JSON whatever the exit code', () => {
    expect(signInReady('claude', { result: 'ok', output: '{"loggedIn":true}' })).toBe(true)
    expect(signInReady('claude', { result: 'failed', output: '{"loggedIn":false}' })).toBe(false)
    expect(signInReady('claude', { result: 'ok', output: 'not json' })).toBe(false)
  })

  it('GitHub needs a login printed; the others an exit code of 0', () => {
    expect(signInReady('github', { result: 'ok', output: 'octo\n' })).toBe(true)
    expect(signInReady('github', { result: 'ok', output: '' })).toBe(false)
    expect(signInReady('codex', { result: 'ok', output: 'Logged in using ChatGPT' })).toBe(true)
    expect(signInReady('codex', { result: 'failed', output: 'Not logged in' })).toBe(false)
    expect(signInReady('gitlab', { result: 'notFound', output: '' })).toBe(false)
    expect(signInReady('kiro', { result: 'timeout', output: '' })).toBe(false)
  })
})
