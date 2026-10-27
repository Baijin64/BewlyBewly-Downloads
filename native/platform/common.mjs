import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'

export function archName() { return process.arch }
export function platformDir(kind) {
  if (kind === 'darwin') return 'darwin-x64+arm64'
  return kind + '-' + archName()
}

export function sanitizeEnv(env = process.env) {
  const clean = { ...env }
  for (const key of ['NODE_OPTIONS', 'NODE_PATH']) delete clean[key]
  if (process.platform !== 'win32') for (const key of ['DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH']) delete clean[key]
  return clean
}

export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// Mirrors NodeRuntime.PrepareSupport: the packaged native module is copied to a
// writable, content-addressed directory so node-gyp-build can dlopen it even when
// the install location is read-only (MSIX WindowsApps, /Applications, /usr).
export function prepareSupport(root, data, kind = process.platform) {
  const directory = platformDir(kind)
  const source = path.join(root, 'node_modules', 'classic-level', 'prebuilds', directory, 'classic-level.node')
  if (!existsSync(source)) return ''
  const expected = hashFile(source)
  const target = path.join(data, 'support', 'classic-level-' + expected.slice(0, 24))
  const destination = path.join(target, 'prebuilds', directory, 'classic-level.node')
  mkdirSync(path.dirname(destination), { recursive: true })
  if (!existsSync(destination) || hashFile(destination) !== expected) {
    const temporary = destination + '.' + process.pid + '.tmp'
    try {
      copyFileSync(source, temporary)
      try { renameSync(temporary, destination) } catch { try { unlinkSync(destination) } catch {} ; renameSync(temporary, destination) }
    } finally { try { unlinkSync(temporary) } catch {} }
  }
  return target
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function killTree(child) {
  if (!child || child.killed || !child.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
}

export function detachedSpawn(executable, args, env, options = {}) {
  return spawn(executable, args, { ...options, detached: true, stdio: options.stdio || 'ignore', env })
}

export function runJson(executable, args, payload, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-1000) })
    const timer = timeout ? setTimeout(() => { try { child.kill() } catch {} ; reject(new Error('本地操作超时')) }, timeout) : null
    child.once('error', error2 => { if (timer) clearTimeout(timer); reject(error2) })
    child.once('exit', code => {
      if (timer) clearTimeout(timer)
      if (code !== 0) { reject(new Error(error || '本地操作失败')); return }
      try { resolve(JSON.parse(output)) } catch { reject(new Error('本地助手返回了无效结果')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}
