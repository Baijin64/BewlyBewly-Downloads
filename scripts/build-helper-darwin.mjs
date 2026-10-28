import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = /(^|\/)(test|tests|benchmark|benchmarks|example|examples|deps|src|types)(\/|$)/
const SKIP_FILE = /\.(cc|cpp|h|gyp|gypi|map|ts)$/
const APP_NAME = 'BewlyDownload.app'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim()
    throw new Error(`${command} 失败（${result.status}）：${detail}`)
  }
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

function copyNativeSources(repoRoot, appRoot) {
  const nativeRoot = path.join(repoRoot, 'native')
  for (const entry of readdirSync(nativeRoot, { withFileTypes: true })) {
    if (['node_modules', 'windows', 'tests', 'linux', 'macos'].includes(entry.name)) continue
    const source = path.join(nativeRoot, entry.name)
    if (entry.isDirectory()) { cpSync(source, path.join(appRoot, entry.name), { recursive: true }); continue }
    if (entry.name.endsWith('.mjs') || entry.name.endsWith('.json') || entry.name.endsWith('.d.mts')) copyFileSync(source, path.join(appRoot, entry.name))
  }
}

function copyModules(repoRoot, appRoot) {
  const modules = path.join(repoRoot, 'native', 'node_modules')
  const destination = path.join(appRoot, 'node_modules')
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    cpSync(path.join(modules, entry.name), path.join(destination, entry.name), {
      recursive: true,
      dereference: true,
      filter: file => {
        const relative = path.relative(modules, file).split(path.sep).join('/')
        if (SKIP_DIRS.test(relative) || SKIP_FILE.test(relative)) return false
        // .bin holds symlinks that point outside the bundle; codesign rejects them
        // and the runtime resolves packages by name, not through PATH shims.
        if (relative.includes('/.bin')) return false
        if (relative.includes('/prebuilds/')) return relative.includes('/prebuilds/darwin-x64+arm64')
        return true
      },
    })
  }
}

function makeIcon(repoRoot, resources) {
  const source = path.join(repoRoot, 'assets', 'icon-512-flat.png')
  if (!existsSync(source)) return
  const iconset = path.join(resources, 'AppIcon.iconset')
  mkdirSync(iconset, { recursive: true })
  for (const size of [16, 32, 64, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), source, '--out', path.join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' })
    if (size <= 256) run('sips', ['-z', String(size * 2), String(size * 2), source, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' })
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AppIcon.icns')])
  rmSync(iconset, { recursive: true, force: true })
}

export async function buildDarwin({ repoRoot, target, bin, stageOnly, out, clean }) {
  if (process.platform !== 'darwin') throw new Error('macOS 安装包必须在 macOS runner 上构建（需要 swiftc、codesign、iconutil）')
  const arch = target.split('-')[1]
  const version = JSON.parse(readFileSync(path.join(repoRoot, 'native', 'package.json'), 'utf8')).version
  const stage = out ? path.resolve(repoRoot, out) : path.join(repoRoot, 'dist', `helper-darwin-${arch}`)
  if (existsSync(stage)) {
    if (!clean) throw new Error('暂存目录已存在：' + stage + '，请加 --clean 或指定 --out')
    await rm(stage, { recursive: true, force: true })
  }
  const tools = bin || path.join(repoRoot, 'dist', 'toolchain', 'bin')
  for (const tool of ['aria2c', 'ffmpeg']) {
    if (!existsSync(path.join(tools, tool))) throw new Error(`缺少 ${tool}：请用 --bin 指定媒体工具目录`)
  }

  mkdirSync(path.join(stage, 'bin'), { recursive: true })
  mkdirSync(path.join(stage, 'licenses'), { recursive: true })
  copyNativeSources(repoRoot, stage)
  copyModules(repoRoot, stage)
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
  ].join('\n') + '\n')

  console.log('编译菜单栏托盘…')
  run('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos11.0`, path.join(repoRoot, 'platforms', 'macos', 'BewlyTray.swift'), '-o', path.join(stage, 'BewlyTray')])
  chmodSync(path.join(stage, 'BewlyTray'), 0o755)

  if (stageOnly) { console.log('Unpacked macOS helper: ' + stage); return stage }

  const delivery = stage + '-package'
  if (existsSync(delivery)) {
    if (!clean) throw new Error('交付目录已存在：' + delivery + '，请加 --clean')
    await rm(delivery, { recursive: true, force: true })
  }
  const contents = path.join(delivery, APP_NAME, 'Contents')
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
  mkdirSync(path.join(contents, 'Resources'), { recursive: true })

  cpSync(stage, path.join(contents, 'Resources', 'native'), { recursive: true })
  copyFileSync(path.join(stage, 'BewlyTray'), path.join(contents, 'MacOS', 'BewlyTray'))
  chmodSync(path.join(contents, 'MacOS', 'BewlyTray'), 0o755)

  console.log('编译启动器…')
  run('xcrun', ['clang', '-O2', '-arch', arch, path.join(repoRoot, 'native', 'macos', 'launcher.c'), '-o', path.join(contents, 'MacOS', 'BewlyDownload')])
  chmodSync(path.join(contents, 'MacOS', 'BewlyDownload'), 0o755)

  const plist = readFileSync(path.join(repoRoot, 'platforms', 'macos', 'Info.plist'), 'utf8').replaceAll('0.2.8', version)
  writeFileSync(path.join(contents, 'Info.plist'), plist)
  makeIcon(repoRoot, path.join(contents, 'Resources'))

  console.log('ad-hoc 签名…')
  // A bundle cannot be signed while it contains unsigned Mach-O files, and --deep
  // would also sign the runtime that is downloaded later into the data directory.
  const nested = [
    path.join(contents, 'MacOS', 'BewlyTray'),
    path.join(contents, 'Resources', 'native', 'bin', 'aria2c'),
    path.join(contents, 'Resources', 'native', 'bin', 'ffmpeg'),
    path.join(contents, 'Resources', 'native', 'node_modules', 'classic-level', 'prebuilds', 'darwin-x64+arm64', 'classic-level.node'),
  ]
  for (const file of nested) if (existsSync(file)) run('codesign', ['--force', '--sign', '-', file])
  run('codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'io.bewly.download.helper', path.join(delivery, APP_NAME)])
  run('codesign', ['--verify', '--strict', '--verbose=2', path.join(delivery, APP_NAME)])

  const zip = path.join(repoRoot, 'dist', `Bewly-DownloadHelper-${version}-macos-${arch}.zip`)
  run('ditto', ['-c', '-k', '--keepParent', path.join(delivery, APP_NAME), zip])
  console.log('macOS package: ' + zip)
  return zip
}
