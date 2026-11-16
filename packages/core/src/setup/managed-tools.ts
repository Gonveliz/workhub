/**
 * Tools Workhub installs and keeps for itself, in a tools folder inside its data folder: never the
 * system, never administrator rights. That folder goes first on the PATH of every process Workhub
 * starts and of its own checks. Pure: the table of fixed download addresses (HTTPS only, pinned
 * versions), where each tool lives in the folder, and the npm arguments. The downloads, checksums
 * and unpacking run in the adapters (managed-tools), the queue in the main process.
 *
 * Checksums: Node.js, the GitHub CLI and the GitLab CLI publish a checksum file next to each
 * release; Git for Windows publishes its SHA-256 sums in the release notes, copied here. npm
 * packages are checked by npm itself against the registry's integrity hash. The install scripts of
 * the installer table (Claude Code, Codex CLI, Kiro) have no published checksum.
 */
import { BUILTIN_AGENTS } from '../domain/builtin-agents'

export type ManagedToolId = 'node' | 'git' | 'github' | 'gitlab' | 'opencode' | 'gemini' | 'codexAdapter'
export type ManagedPlatform = 'darwin' | 'linux' | 'win32'
export type ManagedArch = 'x64' | 'arm64'
export type ArchiveFormat = 'zip' | 'tar.gz'

/** Why an install ended badly, for a plain message in the person's language. */
export type ManagedFailure = 'offline' | 'proxy' | 'http' | 'checksum' | 'locked' | 'diskFull' | 'canceled' | 'badArchive' | 'npm' | 'needsNode' | 'unsupported' | 'failed'
export type ManagedPhase = 'downloading' | 'verifying' | 'unpacking' | 'installing'

export interface ArchiveDownload {
  url: string
  format: ArchiveFormat
  /** Leading folders dropped when unpacking (the archive's own top folder). */
  strip: number
  /** The archive's size, for the list shown before anything downloads. */
  bytes: number
  /** A published checksum file (`<sha256>  <file name>` lines) or a SHA-256 copied from the release notes. */
  checksum: { list: string } | { sha256: string }
}

export interface ArchiveTool {
  kind: 'archive'
  id: ManagedToolId
  version: string
  /** The folder inside the tools folder. */
  folder: string
  /** The official page, cited in the docs and the Settings list. */
  page: string
  downloads: Partial<Record<`${ManagedPlatform}-${ManagedArch}`, ArchiveDownload>>
}

export interface NpmTool {
  kind: 'npm'
  id: ManagedToolId
  /** What npm installs: a package name, or `name@version` when an agent pins one. */
  spec: string
  /** The package whose install scripts are allowed (and only that one). */
  packageName: string
  /** `global`: into the tools folder's npm prefix. `warm`: into npm's own cache, for `npx` (Codex). */
  mode: 'global' | 'warm'
  /** About how much npm downloads (the package and its platform binary), for the list shown first. */
  bytes: number
  page: string
}

export type ManagedTool = ArchiveTool | NpmTool

const NODE_VERSION = '26.13.1'
const GH_VERSION = '2.104.0'
const GLAB_VERSION = '1.130.0'
const GIT_VERSION = '2.56.1'

const node = (file: string, format: ArchiveFormat, bytes: number): ArchiveDownload => ({
  url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${file}`,
  format,
  strip: 1,
  bytes,
  checksum: { list: `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt` }
})
const gh = (file: string, format: ArchiveFormat, strip: number, bytes: number): ArchiveDownload => ({
  url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${file}`,
  format,
  strip,
  bytes,
  checksum: { list: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt` }
})
const glab = (file: string, format: ArchiveFormat, bytes: number): ArchiveDownload => ({
  url: `https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_${file}`,
  format,
  strip: 0,
  bytes,
  checksum: { list: `https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/checksums.txt` }
})
const minGit = (file: string, bytes: number, sha256: string): ArchiveDownload => ({
  url: `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1/MinGit-${GIT_VERSION}-${file}.zip`,
  format: 'zip',
  strip: 0,
  bytes,
  checksum: { sha256 }
})

/** The npm spec Codex sessions start through `npx` (kept in step with the built-in agent). */
const codexAdapterSpec = (): string => BUILTIN_AGENTS.find((a) => a.id === 'codex')?.args.find((a) => a.startsWith('@')) ?? '@agentclientprotocol/codex-acp'
const packageNameOf = (spec: string): string => spec.replace(/^(@?[^@]+)@.*$/, '$1')

/** The fixed table. Every address is HTTPS and fixed; the renderer only ever names an id. */
export const MANAGED_TOOLS: Record<ManagedToolId, ManagedTool> = {
  // Node.js LTS ("Lithium"): https://nodejs.org/dist/index.json and
  // https://nodejs.org/dist/v26.13.1/SHASUMS256.txt, checked 2026-11-16.
  node: {
    kind: 'archive',
    id: 'node',
    version: NODE_VERSION,
    folder: 'node',
    page: 'https://nodejs.org/en/download',
    downloads: {
      'darwin-arm64': node('darwin-arm64.tar.gz', 'tar.gz', 58_340_590),
      'darwin-x64': node('darwin-x64.tar.gz', 'tar.gz', 59_799_324),
      'linux-arm64': node('linux-arm64.tar.gz', 'tar.gz', 62_600_078),
      'linux-x64': node('linux-x64.tar.gz', 'tar.gz', 62_904_977),
      'win32-arm64': node('win-arm64.zip', 'zip', 37_036_542),
      'win32-x64': node('win-x64.zip', 'zip', 41_166_246)
    }
  },
  // MinGit (Git for Windows without a shell, unpacked from a zip, no installer):
  // https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1 (SHA-256 table in the
  // release notes), checked 2026-11-16. Windows only: macOS and Linux have no official archive.
  git: {
    kind: 'archive',
    id: 'git',
    version: GIT_VERSION,
    folder: 'git',
    page: 'https://gitforwindows.org/',
    downloads: {
      'win32-x64': minGit('64-bit', 39_849_768, '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd'),
      'win32-arm64': minGit('arm64', 37_983_254, '96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c')
    }
  },
  // GitHub CLI: https://github.com/cli/cli/releases/tag/v2.104.0 (archives and gh_2.104.0_checksums.txt), checked 2026-11-16.
  github: {
    kind: 'archive',
    id: 'github',
    version: GH_VERSION,
    folder: 'github',
    page: 'https://cli.github.com/',
    downloads: {
      'darwin-arm64': gh('macOS_arm64.zip', 'zip', 1, 14_087_367),
      'darwin-x64': gh('macOS_amd64.zip', 'zip', 1, 15_683_594),
      'linux-arm64': gh('linux_arm64.tar.gz', 'tar.gz', 1, 13_642_444),
      'linux-x64': gh('linux_amd64.tar.gz', 'tar.gz', 1, 15_007_172),
      'win32-arm64': gh('windows_arm64.zip', 'zip', 0, 13_617_206),
      'win32-x64': gh('windows_amd64.zip', 'zip', 0, 15_169_772)
    }
  },
  // GitLab CLI: https://gitlab.com/gitlab-org/cli/-/releases/v1.130.0 (archives and checksums.txt), checked 2026-11-16.
  gitlab: {
    kind: 'archive',
    id: 'gitlab',
    version: GLAB_VERSION,
    folder: 'gitlab',
    page: 'https://gitlab.com/gitlab-org/cli',
    downloads: {
      'darwin-arm64': glab('darwin_arm64.tar.gz', 'tar.gz', 19_221_663),
      'darwin-x64': glab('darwin_amd64.tar.gz', 'tar.gz', 20_984_955),
      'linux-arm64': glab('linux_arm64.tar.gz', 'tar.gz', 18_484_645),
      'linux-x64': glab('linux_amd64.tar.gz', 'tar.gz', 20_206_088),
      'win32-arm64': glab('windows_arm64.zip', 'zip', 18_505_982),
      'win32-x64': glab('windows_amd64.zip', 'zip', 20_487_960)
    }
  },
  // https://opencode.ai/docs/ (npm package opencode-ai; its postinstall links the platform binary), checked 2026-11-16.
  opencode: { kind: 'npm', id: 'opencode', spec: 'opencode-ai', packageName: 'opencode-ai', mode: 'global', bytes: 65_000_000, page: 'https://opencode.ai/docs/' },
  // https://github.com/google-gemini/gemini-cli (npm install -g @google/gemini-cli), checked 2026-11-16.
  gemini: { kind: 'npm', id: 'gemini', spec: '@google/gemini-cli', packageName: '@google/gemini-cli', mode: 'global', bytes: 30_000_000, page: 'https://github.com/google-gemini/gemini-cli' },
  // The ACP adapter Codex sessions start with `npx -y <spec>`: fetched ahead into npm's cache so the
  // first session does not wait on it.
  codexAdapter: {
    kind: 'npm',
    id: 'codexAdapter',
    spec: codexAdapterSpec(),
    packageName: packageNameOf(codexAdapterSpec()),
    mode: 'warm',
    bytes: 80_000_000,
    page: 'https://github.com/openai/codex'
  }
}

export const isManagedToolId = (value: unknown): value is ManagedToolId => typeof value === 'string' && Object.prototype.hasOwnProperty.call(MANAGED_TOOLS, value)

/** The processor architectures with official archives for every tool here. */
export const isManagedArch = (arch: string | undefined): arch is ManagedArch => arch === 'x64' || arch === 'arm64'

/** The archive of a tool for this system, or null (none published, or not an archive tool). */
export function managedDownload(id: ManagedToolId, platform: string, arch: string | undefined): ArchiveDownload | null {
  const tool = MANAGED_TOOLS[id]
  if (tool.kind !== 'archive' || !isManagedArch(arch)) return null
  return tool.downloads[`${platform}-${arch}` as `${ManagedPlatform}-${ManagedArch}`] ?? null
}

/** Whether Workhub can install this tool itself here (npm tools need the private Node.js). */
export function managedAvailable(id: ManagedToolId, platform: string, arch: string | undefined): boolean {
  const tool = MANAGED_TOOLS[id]
  return tool.kind === 'archive' ? managedDownload(id, platform, arch) !== null : managedDownload('node', platform, arch) !== null
}

/** Joins path parts with the platform's separator (core has no `node:path`). */
export function toolPath(platform: string, ...parts: string[]): string {
  const sep = platform === 'win32' ? '\\' : '/'
  return parts
    .flatMap((p) => p.split(/[\\/]/))
    .filter((p, i) => p !== '' || i === 0)
    .join(sep)
}

/** The npm prefix of the agents Workhub installs. */
export const npmPrefixOf = (toolsDir: string, platform: string): string => toolPath(platform, toolsDir, 'npm')

/** The private Node.js and its npm (run as `node npm-cli.js`, never through a shell). */
export function privateNode(toolsDir: string, platform: string): { node: string; npmCli: string } {
  return platform === 'win32'
    ? { node: toolPath(platform, toolsDir, 'node', 'node.exe'), npmCli: toolPath(platform, toolsDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js') }
    : { node: toolPath(platform, toolsDir, 'node', 'bin', 'node'), npmCli: toolPath(platform, toolsDir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') }
}

/** Where npm puts a globally installed package under the prefix. */
export function npmPackageDir(toolsDir: string, platform: string, packageName: string): string {
  const prefix = npmPrefixOf(toolsDir, platform)
  return platform === 'win32' ? toolPath(platform, prefix, 'node_modules', packageName) : toolPath(platform, prefix, 'lib', 'node_modules', packageName)
}

/**
 * The tools folder's folders, in the order they go first on PATH: Node.js and the npm prefix (the
 * agents), then Git and the code host CLIs. A folder that does not exist yet costs nothing, and is
 * there as soon as an install puts something in it.
 */
export function managedPathFolders(toolsDir: string, platform: string): string[] {
  const p = (...parts: string[]) => toolPath(platform, toolsDir, ...parts)
  return platform === 'win32'
    ? [p('node'), p('npm'), p('git', 'cmd'), p('github', 'bin'), p('gitlab', 'bin')]
    : [p('node', 'bin'), p('npm', 'bin'), p('github', 'bin'), p('gitlab', 'bin')]
}

/** npm 11.16 added `allow-scripts`; older npm runs every install script and does not know the flag. */
export function npmHasAllowScripts(version: string): boolean {
  const [major = 0, minor = 0] = version.trim().split('.').map((n) => Number.parseInt(n, 10) || 0)
  return major > 11 || (major === 11 && minor >= 16)
}

/**
 * Install scripts allowed for exactly the package being installed: `--allow-scripts=<name>` where
 * npm has the setting (11.16 and later; npm 12 skips unlisted scripts, which left OpenCode without
 * its binary), and `--ignore-scripts=false` against a user's npmrc that turns them all off.
 * Sources: https://docs.npmjs.com/cli/v11/using-npm/config#allow-scripts and npm's own config
 * definitions (npm 11.16.0 and 12.2.2 on unpkg.com), checked 2026-11-16.
 */
function scriptArgs(tool: NpmTool, npmVersion: string): string[] {
  return ['--ignore-scripts=false', ...(npmHasAllowScripts(npmVersion) ? [`--allow-scripts=${tool.packageName}`] : [])]
}

/** `npm install --global` into the tools folder's prefix. */
export function npmInstallArgs(tool: NpmTool, prefix: string, npmVersion: string): string[] {
  return ['install', '--global', `--prefix=${prefix}`, ...scriptArgs(tool, npmVersion), '--no-fund', '--no-audit', '--loglevel=error', tool.spec]
}

/**
 * Fetches a package into npm's `npx` cache the way `npx -y <spec>` does (the same package list,
 * so the same cache entry), then runs `node -e 0` instead of the package's command.
 */
export function npmWarmArgs(tool: NpmTool, npmVersion: string): string[] {
  return ['exec', '--yes', `--package=${tool.spec}`, ...scriptArgs(tool, npmVersion), '--loglevel=error', '--', 'node', '-e', '0']
}

export function npmUninstallArgs(tool: NpmTool, prefix: string): string[] {
  return ['uninstall', '--global', `--prefix=${prefix}`, '--loglevel=error', tool.packageName]
}

/** Reads a published checksum list (`<sha256>  <name>` or `<sha256> *<name>`) for one file name. */
export function checksumFor(list: string, fileName: string): string | null {
  for (const line of list.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim())
    if (m && m[2] === fileName) return m[1]!.toLowerCase()
  }
  return null
}

/** The last part of a download's address: the name its checksum list uses. */
export const downloadFileName = (url: string): string => url.slice(url.lastIndexOf('/') + 1)

/** The program an archive install must leave behind (checked before the folder is moved into place). */
export function managedExecutable(toolsDir: string, platform: string, id: ManagedToolId): string | null {
  const exe = platform === 'win32' ? '.exe' : ''
  switch (id) {
    case 'node':
      return privateNode(toolsDir, platform).node
    case 'git':
      return toolPath(platform, toolsDir, 'git', 'cmd', `git${exe}`)
    case 'github':
      return toolPath(platform, toolsDir, 'github', 'bin', `gh${exe}`)
    case 'gitlab':
      return toolPath(platform, toolsDir, 'gitlab', 'bin', `glab${exe}`)
    default:
      return null
  }
}
