import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

interface BuildOptions {
  repoRoot: string
  target: string
  bin?: string
  stageOnly: boolean
  out?: string
  clean: boolean
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const target = option('--target') ?? `${process.platform}-${process.arch}`

function option(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const shared: BuildOptions = {
  repoRoot,
  target,
  bin: option('--bin'),
  stageOnly: args.includes('--stage-only'),
  out: option('--out'),
  clean: args.includes('--clean'),
}

if (target.startsWith('win32')) {
  const flags: string[] = []
  // --bin points at the FFmpeg build (dist/toolchain/ffmpeg/win32-x64 by default).
  if (shared.bin)
    flags.push('-FfmpegDirectory', shared.bin)
  if (shared.stageOnly)
    flags.push('-StageOnly')
  if (args.includes('--dev-sign'))
    flags.push('-DevSign')
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(repoRoot, 'scripts', 'build-helper.ps1'),
      ...flags,
    ],
    { stdio: 'inherit' },
  )
  process.exit(result.status ?? 1)
}

if (target.startsWith('darwin') || target.startsWith('linux')) {
  console.error(
    `${target} 打包脚本仍在沿用已退役的 Node 目录结构（launcher.sh / fetch-node.sh / node_modules 裁剪），尚未重写。`
    + '请先运行 cargo build --release；Windows 打包不受影响。',
  )
  process.exit(3)
}

console.error(`未知构建目标：${target}`)
process.exit(2)
