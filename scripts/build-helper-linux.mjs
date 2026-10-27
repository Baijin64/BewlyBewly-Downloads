import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = /(^|\/)(test|tests|benchmark|benchmarks|example|examples|deps|src|types)(\/|$)/
const SKIP_FILE = /\.(cc|cpp|h|gyp|gypi|map|ts)$/

function copyNativeSources(repoRoot, appRoot) {
  const nativeRoot = path.join(repoRoot, 'native')
  for (const entry of readdirSync(nativeRoot, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'windows' || entry.name === 'tests' || entry.name === 'linux') continue
    const source = path.join(nativeRoot, entry.name)
    if (entry.isDirectory()) { cpSync(source, path.join(appRoot, entry.name), { recursive: true }); continue }
    if (entry.name.endsWith('.mjs') || entry.name.endsWith('.json') || entry.name.endsWith('.d.mts')) copyFileSync(source, path.join(appRoot, entry.name))
  }
}

function copyModules(repoRoot, appRoot, target) {
  const modules = path.join(repoRoot, 'native', 'node_modules')
  const destination = path.join(appRoot, 'node_modules')
  const allowed = target.startsWith('linux') ? new Set(['linux-x64', 'linux-arm64']) : new Set(['darwin-x64+arm64'])
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const source = path.join(modules, entry.name)
    const target_ = path.join(destination, entry.name)
    cpSync(source, target_, {
      recursive: true,
      dereference: true,
      filter: file => {
        const relative = path.relative(modules, file).split(path.sep).join('/')
        if (SKIP_DIRS.test(relative) || SKIP_FILE.test(relative)) return false
        if (relative.includes('/.bin')) return false
        if (relative.includes('/prebuilds/')) {
          const parts = relative.split('/')
          const index = parts.indexOf('prebuilds')
          const platform = parts[index + 1] || ''
          if (!allowed.has(platform)) return false
        }
        return true
      },
    })
  }
}

export async function buildLinux({ repoRoot, target, bin, stageOnly, out, clean }) {
  const arch = target.split('-')[1]
  const version = JSON.parse(readFileSync(path.join(repoRoot, 'native', 'package.json'), 'utf8')).version
  const stage = out ? path.resolve(repoRoot, out) : path.join(repoRoot, 'dist', `helper-linux-${arch}`)
  if (existsSync(stage)) {
    if (!clean) throw new Error('暂存目录已存在：' + stage + '，请加 --clean 或指定 --out')
    await rm(stage, { recursive: true, force: true })
  }
  const tools = bin || path.join(repoRoot, 'dist', 'private-build-deps', 'bin')
  for (const tool of ['aria2c', 'ffmpeg']) {
    if (!existsSync(path.join(tools, tool))) throw new Error(`缺少 ${tool}：请用 --bin 指定媒体工具目录`)
  }

  mkdirSync(path.join(stage, 'bin'), { recursive: true })
  mkdirSync(path.join(stage, 'licenses'), { recursive: true })
  copyNativeSources(repoRoot, stage)
  copyModules(repoRoot, stage, target)
  for (const tool of ['aria2c', 'ffmpeg']) {
    copyFileSync(path.join(tools, tool), path.join(stage, 'bin', tool))
    chmodSync(path.join(stage, 'bin', tool), 0o755)
  }
  for (const script of ['launcher.sh', 'degraded.sh', 'fetch-node.sh']) chmodSync(path.join(stage, 'posix', script), 0o755)
  copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(stage, 'licenses', 'BewlyBewly-MIT.txt'))
  writeFileSync(path.join(stage, 'licenses', 'THIRD-PARTY.txt'), [
    'Bundled media tools (independent processes, not linked with Bewly code):',
    'aria2: https://github.com/aria2/aria2 (GPL-2.0-or-later)',
    'FFmpeg: https://ffmpeg.org/ (LGPL-2.1-or-later build)',
    'Exact source archives and build flags are published in the same release as this package.',
    'Node.js is not redistributed in this package; a compatible runtime is resolved at install time.',
  ].join('\n') + '\n')

  if (stageOnly) { console.log('Unpacked Linux helper: ' + stage); return stage }

  const delivery = path.join(stage + '-package')
  if (existsSync(delivery)) {
    if (!clean) throw new Error('交付目录已存在：' + delivery + '，请加 --clean')
    await rm(delivery, { recursive: true, force: true })
  }
  mkdirSync(delivery, { recursive: true })
  cpSync(stage, path.join(delivery, 'app'), { recursive: true })
  for (const file of ['install.sh', 'uninstall.sh']) {
    copyFileSync(path.join(repoRoot, 'native', 'linux', file), path.join(delivery, file))
    chmodSync(path.join(delivery, file), 0o755)
  }
  mkdirSync(path.join(delivery, 'linux'), { recursive: true })
  copyFileSync(path.join(repoRoot, 'native', 'linux', 'bewly-download.service'), path.join(delivery, 'linux', 'bewly-download.service'))
  writeFileSync(path.join(delivery, 'README.txt'), [
    'Bewly 下载助手（Linux）',
    '',
    '安装：sh install.sh            （装到 ~/.local，无需 root）',
    '      sh install.sh --systemd  （同时启用 systemd --user 常驻）',
    '卸载：sh uninstall.sh [--purge]',
    '',
    '安装后请重启浏览器。首次连接会使用系统 Node.js 24+，缺失时自动下载到用户目录。',
  ].join('\n') + '\n')

  const tarball = path.join(repoRoot, 'dist', `Bewly-DownloadHelper-${version}-linux-${arch}.tar.gz`)
  // GNU tar parses "C:\..." as a remote host; use a relative output path from the
  // delivery directory so the same script works on Windows and POSIX.
  const relative = path.relative(delivery, tarball).split(path.sep).join('/')
  const tar = spawnSync('tar', ['-czf', relative, '.'], { cwd: delivery, encoding: 'utf8' })
  if (tar.status !== 0) throw new Error('打包失败：' + (tar.stderr || tar.status))
  console.log('Linux package: ' + tarball)
  return tarball
}
