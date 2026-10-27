import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const nativeRoot = path.join(repoRoot, 'native')

export function stageRoot() {
  if (process.env.BEWLY_NATIVE_TEST_ROOT) return process.env.BEWLY_NATIVE_TEST_ROOT
  if (process.platform === 'win32') return path.join(repoRoot, 'dist', 'helper-msix')
  return path.join(repoRoot, 'dist', 'helper-' + (process.platform === 'darwin' ? 'darwin' : 'linux') + '-' + process.arch)
}

// Windows drives the C# host; POSIX runs the Node host directly. Tests use this
// so the same protocol assertions work on every platform.
export function hostCommand() {
  if (process.platform === 'win32') return [path.join(stageRoot(), 'BewlyDownloadHost.exe')]
  return [process.execPath, path.join(nativeRoot, 'posix', 'host.mjs')]
}

// Executable that accepts the extension origin as its first argument.
export function hostExecutable() {
  if (process.platform === 'win32') return path.join(stageRoot(), 'BewlyDownloadHost.exe')
  return path.join(nativeRoot, 'posix', 'launcher.sh')
}

export function hostAvailable() {
  return existsSync(hostExecutable())
}

export function toolPath(name) {
  return path.join(stageRoot(), 'bin', process.platform === 'win32' ? name + '.exe' : name)
}

export function toolsAvailable() {
  return existsSync(toolPath('aria2c')) && existsSync(toolPath('ffmpeg'))
}
