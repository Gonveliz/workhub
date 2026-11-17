#!/usr/bin/env node
/**
 * Builds the installers for one OS into dist/ (git-ignored).
 *   node scripts/dist.mjs [mac|win|linux] [--dir]     default: this OS; --dir builds only the unpacked app
 * Steps: stage the Claude bridge for the target, electron-vite build, electron-builder.
 * node-pty is a native module, so each OS builds its own installers (CI runs one job per OS).
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(root, 'packages', 'app')
const hostOs = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]
const args = process.argv.slice(2)
const target = args.find((a) => ['mac', 'win', 'linux'].includes(a)) ?? hostOs
const dirOnly = args.includes('--dir')

if (target !== hostOs) {
  console.error(`dist:${target} must run on ${target} (node-pty is native and is not cross-built). CI builds every OS: see .github/workflows/release.yml.`)
  process.exit(1)
}

const platform = { mac: 'darwin', win: 'win32', linux: 'linux' }[target]
// macOS ships arm64 only for now; Windows and Linux ship x64.
const arch = target === 'mac' ? 'arm64' : 'x64'
const builderArch = target === 'mac' && process.arch !== 'arm64' ? null : arch
if (!builderArch) {
  console.error('The macOS build is arm64 only: run it on an Apple Silicon Mac.')
  process.exit(1)
}

// Windows runs a .cmd (npm, electron-builder) only through a shell, which splits an unquoted path at
// its spaces ("C:\Program Files\..."): quote what goes through it. Node itself needs no shell.
const quote = (s) => (/\s/.test(s) ? `"${s}"` : s)
const run = (cmd, argv, cwd = root) =>
  process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    ? execFileSync(quote(cmd), argv.map(quote), { cwd, stdio: 'inherit', shell: true })
    : execFileSync(cmd, argv, { cwd, stdio: 'inherit' })
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

run(process.execPath, [join(root, 'scripts', 'stage-bridge.mjs'), '--platform', platform, '--arch', arch])
run(npm, ['run', 'build'])
const builder = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')
run(builder, ['--config', 'electron-builder.config.mjs', `--${target}`, `--${arch}`, '--publish', 'never', ...(dirOnly ? ['--dir'] : [])], appDir)
