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
  if (shared.bin)
    flags.push('-BinDirectory', shared.bin)
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

if (target.startsWith('darwin')) {
  const { buildDarwin } = (await import('./build-helper-darwin.mjs')) as {
    buildDarwin: (options: BuildOptions) => Promise<void>
  }
  await buildDarwin(shared)
  process.exit(0)
}

if (target.startsWith('linux')) {
  const { buildLinux } = (await import('./build-helper-linux.mjs')) as {
    buildLinux: (options: BuildOptions) => Promise<void>
  }
  await buildLinux(shared)
  process.exit(0)
}

console.error(`未知构建目标：${target}`)
process.exit(2)
