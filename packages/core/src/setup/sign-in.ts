/**
 * Signing in to a tool inside Workhub: the fixed list of tools, the command each one signs in
 * with (its own browser or device flow; Workhub never asks for or stores a password or token), the
 * command that tells whether it worked, and the reader that finds the web address and one-time
 * code a flow prints. Pure: the main process runs the commands in a terminal.
 *
 * Sources, checked 2026-11-16:
 * - Claude Code: https://code.claude.com/docs/en/cli-reference (`claude auth login`; `claude auth status`
 *   prints JSON and exits 0 when signed in, 1 when not)
 * - Codex: https://learn.chatgpt.com/docs/auth (`codex login` is the browser flow, `codex login status`);
 *   output from https://github.com/openai/codex (codex-rs/cli/src/login.rs, codex-rs/login/src/device_code_auth.rs)
 * - Kiro CLI: https://kiro.dev/docs/reference/cli-commands/ (`kiro-cli login`, `kiro-cli whoami`)
 * - GitHub CLI: https://cli.github.com/manual/gh_auth_login (`--web`); output from
 *   https://github.com/cli/cli (internal/authflow/flow.go: "! First copy your one-time code: …",
 *   "Press Enter to open … in your browser...")
 * - GitLab CLI: https://docs.gitlab.com/cli/auth/login/ (`--web`) and https://docs.gitlab.com/cli/auth/status/
 */

export const SIGN_IN_TOOLS = ['claude', 'codex', 'kiro', 'github', 'gitlab'] as const
export type SignInTool = (typeof SIGN_IN_TOOLS)[number]

/** True only for a tool of the fixed list: anything else a caller sends is refused. */
export const isSignInTool = (value: unknown): value is SignInTool => typeof value === 'string' && (SIGN_IN_TOOLS as readonly string[]).includes(value)

export interface SignInCommand {
  /** The executable, looked up on the app's PATH (the bundled Claude Code is last on it). */
  command: string
  args: string[]
  /** The check that says the sign-in worked; `ready` reads its outcome. */
  status: { command: string; args: string[] }
  /**
   * Keys typed into the terminal after "Open browser": the GitHub CLI waits for Enter before it
   * starts waiting for the browser.
   */
  afterOpen?: string
  /** Environment for the sign-in command only. */
  env?: Record<string, string>
  /** The page that takes the one-time code, for a flow that prints the code but not a full address. */
  deviceUrl?: string
}

/** The only commands the sign-in pane runs. Accounts only change the environment (Claude's config folder). */
export const SIGN_IN_COMMANDS: Record<SignInTool, SignInCommand> = {
  claude: { command: 'claude', args: ['auth', 'login'], status: { command: 'claude', args: ['auth', 'status'] } },
  // The browser flow: the device-code flow has to be turned on in the ChatGPT account first.
  codex: { command: 'codex', args: ['login'], status: { command: 'codex', args: ['login', 'status'] } },
  kiro: { command: 'kiro-cli', args: ['login'], status: { command: 'kiro-cli', args: ['whoami'] } },
  // The same check as the setup row (`gh api user`), so the pane and the row agree.
  github: {
    command: 'gh',
    args: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
    status: { command: 'gh', args: ['api', 'user', '--jq', '.login'] },
    afterOpen: '\r',
    // "Open browser" opens the page through Workhub's link service, then presses Enter for gh: a
    // no-op browser command keeps gh from opening a second tab (when it cannot run one, gh prints
    // the address and goes on waiting).
    env: { GH_BROWSER: 'true' },
    deviceUrl: 'https://github.com/login/device'
  },
  gitlab: {
    command: 'glab',
    args: ['auth', 'login', '--hostname', 'gitlab.com', '--git-protocol', 'https', '--web'],
    status: { command: 'glab', args: ['auth', 'status', '--hostname', 'gitlab.com'] }
  }
}

/** What a sign-in flow printed for a person to act on. */
export interface SignInPrompt {
  /** The web address to open (http or https, never a local callback server). */
  url: string | null
  /** The one-time code to enter on that page. */
  code: string | null
}

// CSI sequences (colors, cursor moves), OSC sequences (titles, OSC 8 hyperlinks) and lone escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Terminal output as plain text: escapes gone, carriage returns as line breaks. */
export function plainTerminalText(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n')
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

/** A web address a person can open: http(s), not the tool's own callback server on this machine. */
function openableUrl(raw: string): string | null {
  const trimmed = raw.replace(/[.,;:!?'")\]}>]+$/, '')
  // Core has no URL class: the host is read by hand (no user info in these addresses).
  const host = /^https?:\/\/(\[[^\]]*\]|[^/:?#]+)/i.exec(trimmed)?.[1]
  if (!host || LOOPBACK.has(host.toLowerCase())) return null
  return trimmed
}

// A device code: groups of capital letters and digits joined by hyphens (`ABCD-1234`). Ordinary
// words, numbers and "exit code: 1" do not have that shape.
const CODE = '([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)'
const CODE_SHAPES = [
  // GitHub CLI: "! First copy your one-time code: ABCD-1234"
  new RegExp(`one-time code:\\s*${CODE}\\b`),
  // Codex device flow: "2. Enter this one-time code (expires in 15 minutes)\n   ABCD-12345"
  new RegExp(`one-time code[^\\n]*\\n\\s*${CODE}\\b`),
  // AWS-style device flows (Kiro): "Code: ABCD-EFGH" or "user code: ABCD-EFGH"
  new RegExp(`\\b(?:[Uu]ser )?[Cc]ode:\\s*${CODE}\\b`)
]

/**
 * The newest web address and one-time code in a flow's output (the whole output so far, or its
 * tail). Null parts were not printed (Claude Code and the browser flows print only an address).
 */
export function parseSignInPrompt(output: string): SignInPrompt {
  const text = plainTerminalText(output)
  let url: string | null = null
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>`]+/g)) url = openableUrl(m[0]) ?? url
  let code: string | null = null
  let at = -1
  for (const shape of CODE_SHAPES) {
    for (const m of text.matchAll(new RegExp(shape.source, 'g'))) {
      if (m.index! > at) {
        at = m.index!
        code = m[1]!
      }
    }
  }
  // A verification address that carries the code (`?user_code=ABCD-EFGH`) when no line spelled it out.
  if (!code && url) {
    const inUrl = new RegExp(`[?&#]user_code=${CODE}`).exec(url)
    if (inUrl) code = inUrl[1]!
  }
  return { url, code }
}

/** Whether the status check's outcome means signed in. Claude's JSON is read (it may exit non-zero and still print it). */
export function signInReady(tool: SignInTool, p: { result: 'ok' | 'failed' | 'notFound' | 'timeout'; output: string }): boolean {
  if (tool === 'claude') {
    try {
      const value = JSON.parse(p.output) as { loggedIn?: unknown } | null
      return value !== null && typeof value === 'object' && value.loggedIn === true
    } catch {
      return false
    }
  }
  // `gh api user --jq .login` prints the login only when the token works.
  if (tool === 'github') return p.result === 'ok' && p.output.trim() !== ''
  return p.result === 'ok'
}
