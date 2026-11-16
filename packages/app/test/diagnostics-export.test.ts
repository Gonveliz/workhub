import { describe, expect, it } from 'vitest'
import { exportDiagnostics, type ExportFs } from '../src/main/diagnostics-export'

function fakeFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial))
  const dirs: string[] = []
  const fs: ExportFs = {
    mkdir: async (p) => void dirs.push(p),
    readdir: async (p) => [...files.keys()].filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)),
    readFile: async (p) => {
      const t = files.get(p)
      if (t === undefined) throw new Error('missing')
      return t
    },
    writeFile: async (p, t) => void files.set(p, t)
  }
  return { fs, files, dirs }
}

describe('exportDiagnostics', () => {
  it('writes the logs, versions, jobs, database size and a redacted config, and nothing else', async () => {
    const { fs, files, dirs } = fakeFs({
      '/data/logs/main.log': 'ok line\nfailed with sk-ant-api03-abcdefghijklmnop\n',
      '/data/logs/main.1.log': 'old\n',
      '/data/logs/main.2.log': 'older\n',
      '/data/logs/notes.txt': 'not a log',
      '/data/secrets.json': 'SECRET',
      '/data/workhub.db': 'DB'
    })
    const out = await exportDiagnostics({
      fs,
      target: '/picked',
      logsDir: '/data/logs',
      info: { app: '1.0.0', electron: '40', node: '24', chrome: '140', os: 'Linux 6', arch: 'x64', packaged: true },
      jobs: [{ name: 'health alerts', lastRunAt: 1, lastOkAt: 1, lastError: null, failures: 0 }],
      storage: { path: '/data/workhub.db', sizeBytes: 4096, backupFolder: '/data/backups', lastBackup: '/data/backups/x.db', recovered: null },
      config: { apiKey: 'abc', workspace: '/home/ann/code', theme: 'dark' },
      now: () => new Date('2026-01-02T03:04:05.678Z')
    })
    expect(dirs).toEqual(['/picked/workhub-diagnostics-2026-01-02T03-04-05'])
    expect(out.files).toEqual(['main.1.log', 'main.2.log', 'main.log', 'versions.json', 'jobs.json', 'database.json', 'config.redacted.json'])
    const written = [...files.keys()].filter((f) => f.startsWith('/picked/'))
    expect(written).toHaveLength(out.files.length)
    expect(written.join('\n')).not.toMatch(/secrets|workhub\.db|notes/)
    const all = written.map((f) => files.get(f)).join('\n')
    expect(all).not.toContain('sk-ant')
    expect(all).not.toContain('/home/ann')
    expect(all).not.toContain('/data/')
    expect(JSON.parse(files.get(`${out.folder}/config.redacted.json`)!)).toEqual({ apiKey: '[redacted]', workspace: '[path]', theme: 'dark' })
    expect(JSON.parse(files.get(`${out.folder}/database.json`)!).sizeBytes).toBe(4096)
  })

  it('still writes the rest when the logs folder is missing', async () => {
    const { fs } = fakeFs({})
    const out = await exportDiagnostics({ fs, target: '/p', logsDir: '/none', info: { app: '1', electron: '1', node: '1', chrome: '1', os: 'x', arch: 'x', packaged: false }, jobs: [], storage: null, config: null })
    expect(out.files).toEqual(['versions.json', 'jobs.json', 'database.json', 'config.redacted.json'])
  })
})
