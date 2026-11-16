#!/usr/bin/env node
// `npm run smoke`: boots the built app on the demo scenario and walks every main screen and the
// Settings window over the Chrome DevTools Protocol, so a screen that crashes on start is caught
// before a release. No dependencies; Node 24 (global WebSocket and fetch).
//
//   npm run build && npm run smoke              needs packages/app/out
//   npm run smoke -- --shots <dir>              also saves one PNG per screen
//   npm run smoke -- --size 1280x800            page size to set before navigating (default 1280x800)
//   xvfb-run -a -s "-screen 0 1920x1080x24" npm run smoke   on a Linux machine without a display
//
// The app runs from this clone only, with a temporary data folder and the demo variables. The
// agents' own folders (Claude, Codex, OpenCode, Kiro) point at empty temporary folders where the app
// honors a variable for them; HOME is never changed. History is never screenshotted, as a reader may
// still see the real home folder. The folders and
// the app are removed on exit, whatever the outcome.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(root, 'packages', 'app')
const args = process.argv.slice(2)

const fail = (message, code = 1) => {
  console.error(`smoke: FAILED: ${message}`)
  process.exit(code)
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run smoke [-- --shots <dir>] [--size <width>x<height>]\n\n  --shots <dir>  save one screenshot per screen into <dir>\n  --size WxH     set the main page to this size before navigating (default 1280x800)\n\nNeeds a build: npm run build')
  process.exit(0)
}
let shotsDir
let size = { width: 1280, height: 800 }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shots') {
    shotsDir = args[++i]
    if (!shotsDir) fail('--shots needs a folder', 2)
  } else if (args[i] === '--size') {
    const m = /^(\d{3,5})x(\d{3,5})$/.exec(args[++i] ?? '')
    if (!m) fail('--size needs <width>x<height>, for example 1280x800', 2)
    size = { width: Number(m[1]), height: Number(m[2]) }
  } else fail(`unknown option ${args[i]}. Try: npm run smoke -- --help`, 2)
}

if (!existsSync(join(appDir, 'out', 'main', 'index.js')) || !existsSync(join(appDir, 'out', 'renderer', 'index.html'))) {
  fail('there is no build in packages/app/out. Run `npm run build` first, then `npm run smoke` again.', 2)
}
const electron = createRequire(join(appDir, 'package.json'))('electron')
if (typeof electron !== 'string' || !existsSync(electron)) fail('the Electron binary is missing. Run `npm ci`.', 2)
if (shotsDir) {
  shotsDir = resolve(shotsDir)
  mkdirSync(shotsDir, { recursive: true })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise((res, rej) => {
    const server = createServer()
    server.once('error', rej)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => res(port))
    })
  })

const tmp = mkdtempSync(join(tmpdir(), 'workhub-smoke-'))
const dataDir = join(tmp, 'data')
// The folders the agents' readers honor, empty. HOME is left alone on purpose: a fake home makes
// macOS report a missing login keychain (safeStorage). Readers that only look in the real home
// folder are listed in the header; History is checked but never photographed.
const claudeDir = join(tmp, 'claude')
const codexDir = join(tmp, 'codex')
const kiroDir = join(tmp, 'kiro')
const xdgData = join(tmp, 'xdg-data')
for (const d of [dataDir, claudeDir, codexDir, kiroDir, xdgData]) mkdirSync(d, { recursive: true })

const env = { ...process.env }
for (const name of ['WORKHUB_SOCKET', 'WORKHUB_SESSION', 'WORKHUB_URL', 'WORKHUB_TOKEN', 'ELECTRON_RUN_AS_NODE']) delete env[name]
Object.assign(env, {
  WORKHUB_DATA_DIR: dataDir,
  WORKHUB_DEMO_SCENARIO: 'team-lead',
  WORKHUB_DEMO_TICKETS: '1',
  WORKHUB_DEMO_CODEHOST: '1',
  WORKHUB_DEMO_SLACK: '1',
  WORKHUB_DEMO_HEALTH: '1',
  WORKHUB_DEMO_USAGE: '1',
  WORKHUB_DEMO_CALENDAR: '1',
  CLAUDE_CONFIG_DIR: claudeDir,
  CODEX_HOME: codexDir,
  WORKHUB_KIRO_DIR: kiroDir,
  XDG_DATA_HOME: xdgData
})

let child
let stopped = false
const stopApp = async () => {
  if (stopped) return
  stopped = true
  if (child?.pid && child.exitCode === null) {
    // The app and its helpers share one process group (spawned detached), so the group is the app and nothing else.
    const signal = (s) => {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
        else process.kill(-child.pid, s)
      } catch {
        /* already gone */
      }
    }
    signal('SIGTERM')
    for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250)
    if (child.exitCode === null) signal('SIGKILL')
    await sleep(300)
  }
}
const cleanup = async () => {
  await stopApp()
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(tmp, { recursive: true, force: true })
      return
    } catch {
      await sleep(500)
    }
  }
  console.error(`smoke: could not remove ${tmp}`)
}
let finishing = false
const finish = async (code, message) => {
  if (finishing) return
  finishing = true
  if (message) console.error(`smoke: FAILED: ${message}`)
  if (message) {
    // The tail of the app's own log usually says why; the data is the demo's, never a real session.
    try {
      const tail = readFileSync(join(dataDir, 'logs', 'main.log'), 'utf8').trimEnd().split('\n').slice(-12)
      console.error(`smoke: last lines of main.log:\n${tail.join('\n')}`)
    } catch {
      /* no log yet */
    }
  }
  await cleanup()
  process.exit(code)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void finish(130))
process.on('uncaughtException', (e) => void finish(1, e?.stack ?? String(e)))
process.on('unhandledRejection', (e) => void finish(1, e?.stack ?? String(e)))

// A small CDP client for one page target.
async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('could not open the DevTools socket'))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) pending.get(d.id)(d)
  }
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  return {
    async evaluate(expression) {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.error) throw new Error(r.error.message)
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
      return r.result.result?.value
    },
    call,
    async shot(file) {
      const r = await call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(file, Buffer.from(r.result.data, 'base64'))
    },
    close: () => ws.close()
  }
}

async function pages(port) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    return targets.filter((t) => t.type === 'page')
  } catch {
    return []
  }
}

let lastPort = 0
async function waitFor(what, fn, ms = 30000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited (code ${child.exitCode}) while waiting for ${what}`)
    try {
      last = await fn()
      if (last) return last
    } catch {
      /* not ready yet */
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${process.env['SMOKE_VERBOSE'] ? `; pages: ${JSON.stringify((await pages(lastPort)).map((t) => t.url))}` : ''}`)
}

// What a screen must satisfy once it shows: some text, and no error-boundary fallback (its title in
// either language, or its alert role, which only the boundary renders around a code element).
const CHECK = `(() => {
  const text = (document.body?.innerText ?? '').trim()
  const fallback = [...document.querySelectorAll('[role="alert"]')].some((e) => /Something went wrong|Algo salió mal/.test(e.textContent ?? ''))
  return { length: text.length, fallback, text: text.slice(0, 120) }
})()`

async function assertScreen(page, name) {
  const r = await page.evaluate(CHECK)
  if (r.fallback) throw new Error(`${name}: the error boundary fallback is showing`)
  if (r.length < 20) throw new Error(`${name}: the page has no content (${r.length} characters)`)
}

// The one error a CI runner always logs: a Linux runner has no keyring, so Electron's safeStorage is
// unavailable and the app (rightly) refuses to keep secrets in plain text. Any other ERROR line fails.
const KNOWN_LOG_ERROR = /^\S+ ERROR OS encryption is not available; Workhub will not store secrets in plain text\.\s*$/
const isBadLogLine = (l) => !KNOWN_LOG_ERROR.test(l) && (/^\S+ ERROR /.test(l) || l.includes('render-process-gone') || /renderer gone/.test(l))

// The page's size is fixed over the DevTools protocol so a display's size (xvfb defaults to 640x480)
// does not decide what the top bar shows. Electron has no Browser.setWindowBounds, so this overrides
// the page's metrics, which is what the layout reads; the OS window may still be larger or smaller.
async function setViewportSize(page, { width, height }) {
  const r = await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  if (r.error) throw new Error(`could not size the page: ${r.error.message}`)
  await sleep(500)
  return page.evaluate('({ width: window.innerWidth, height: window.innerHeight })')
}

const SCREENS = [
  ['Home', 'home'],
  ['Pull requests', 'pullRequests'],
  ['Tickets', 'tickets'],
  ['Automations', 'automations'],
  ['History', 'history'],
  ['Health', 'health'],
  ['Plan', 'plan'],
  ['Usage', 'usage']
]

async function main() {
  const port = await freePort()
  lastPort = port
  console.log(`smoke: data folder ${dataDir}, debugging port ${port}`)
  // A Linux runner has no setuid chrome-sandbox helper; the flag is only for CI (WORKHUB_SMOKE_NO_SANDBOX=1).
  const flags = process.env['WORKHUB_SMOKE_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : []
  child = spawn(electron, ['.', `--remote-debugging-port=${port}`, ...flags], {
    cwd: appDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32'
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
  child.on('error', (e) => void finish(1, `could not start Electron: ${e.message}`))

  const mainTarget = await waitFor('the main window', async () => (await pages(port)).find((t) => !t.url.includes('#') && t.url.includes('index.html')), 60000)
  const mainPage = await connect(mainTarget.webSocketDebuggerUrl)
  await waitFor('the navigation bar', () => mainPage.evaluate(`document.readyState === 'complete' && !!document.querySelector('[data-route]')`), 60000)
  console.log('smoke: main window is up')
  const got = await setViewportSize(mainPage, size)
  console.log(`smoke: page size ${got.width}x${got.height} (asked for ${size.width}x${size.height})`)

  const shot = async (page, name) => {
    if (shotsDir) await page.shot(join(shotsDir, `${name}.png`))
  }

  for (const [name, route] of SCREENS) {
    // The demo profile's modules (Automations, Health, Plan) arrive with the first config snapshot.
    // The top bar folds to icons when narrow but keeps every entry in the page; if one is missing, say which are there.
    try {
      await waitFor(`the ${name} navigation entry`, () => mainPage.evaluate(`!!document.querySelector('[data-route="${route}"]')`), 30000)
    } catch (e) {
      const present = await mainPage.evaluate(`[...document.querySelectorAll('[data-route]')].map((b) => b.dataset.route).join(', ')`)
      const dims = await mainPage.evaluate('`${window.innerWidth}x${window.innerHeight}`')
      throw new Error(`${e.message} (page ${dims}; entries present: ${present || 'none'})`)
    }
    const clicked = await mainPage.evaluate(`(() => { const b = document.querySelector('[data-route="${route}"]'); if (!b) return false; b.click(); return true })()`)
    if (!clicked) throw new Error(`${name}: there is no navigation entry for it (route ${route})`)
    await waitFor(`${name} to be current`, () => mainPage.evaluate(`document.querySelector('[data-route="${route}"]')?.getAttribute('aria-current') === 'page'`), 10000)
    await sleep(1500)
    await assertScreen(mainPage, name)
    if (route !== 'history') await shot(mainPage, route)
    console.log(`smoke: ok  ${name}`)
  }

  for (const [name, section] of [['Settings: General', 'general'], ['Settings: Advanced', 'advanced']]) {
    await mainPage.evaluate(`window.hub.settings.open(${JSON.stringify(section)})`)
    const target = await waitFor('the Settings window', async () => (await pages(port)).find((t) => t.url.includes('#settings')), 20000)
    const page = await connect(target.webSocketDebuggerUrl)
    try {
      await waitFor(`${name} to render`, () => page.evaluate(`document.readyState === 'complete' && (document.body?.innerText ?? '').trim().length > 20`), 20000)
      await sleep(1000)
      await assertScreen(page, name)
      await shot(page, `settings-${section}`)
    } finally {
      page.close()
    }
    console.log(`smoke: ok  ${name}`)
  }
  mainPage.close()

  // Read the log while the app still runs: stopping it kills its renderers, which the log records as an error of ours.
  await sleep(1000)
  const logFile = join(dataDir, 'logs', 'main.log')
  if (!existsSync(logFile)) throw new Error(`there is no log at ${logFile}`)
  const lines = readFileSync(logFile, 'utf8').split('\n')
  const bad = lines.filter(isBadLogLine)
  if (bad.length > 0) throw new Error(`main.log has ${bad.length} error line(s), first: ${bad[0].slice(0, 300)}`)
  await stopApp()
  console.log(`smoke: ok  main.log (${lines.length} lines, no ERROR, no render-process-gone)`)
  if (stderr && process.env['SMOKE_VERBOSE']) console.log(stderr)
}

try {
  await main()
  console.log('smoke: PASSED')
  await finish(0)
} catch (e) {
  await finish(1, e.message)
}
