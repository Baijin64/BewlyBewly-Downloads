import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const target = option('--target') || `${process.platform}-${process.arch}`

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

if (target.startsWith('win32')) {
  const flags = []
  if (option('--bin')) flags.push('-BinDirectory', option('--bin'))
  if (args.includes('--stage-only')) flags.push('-StageOnly')
  if (args.includes('--dev-sign')) flags.push('-DevSign')
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'build-helper.ps1'), ...flags], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

if (target.startsWith('darwin')) {
  const { buildDarwin } = await import('./build-helper-darwin.mjs')
  await buildDarwin({ repoRoot, target, bin: option('--bin'), stageOnly: args.includes('--stage-only'), out: option('--out'), clean: args.includes('--clean') })
  process.exit(0)
}

if (target.startsWith('linux')) {
  const { buildLinux } = await import('./build-helper-linux.mjs')
  await buildLinux({ repoRoot, target, bin: option('--bin'), stageOnly: args.includes('--stage-only'), out: option('--out'), clean: args.includes('--clean') })
  process.exit(0)
}

console.error('未知构建目标：' + target)
process.exit(2)
