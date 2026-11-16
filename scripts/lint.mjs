#!/usr/bin/env node
/**
 * `npm run lint`: runs ESLint from tools/lint, which has its own dependencies because typescript-eslint
 * needs the TypeScript 6 JavaScript API while the workspace compiles with TypeScript 7. The first run
 * installs them (from tools/lint/package-lock.json, scripts disabled); later runs go straight to ESLint.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lintDir = join(root, 'tools', 'lint')
const eslint = join(lintDir, 'node_modules', 'eslint', 'bin', 'eslint.js')
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (!existsSync(eslint)) run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], lintDir)
run(process.execPath, [eslint, ...process.argv.slice(2), '.'], root)
