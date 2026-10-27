import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

import { platform } from '../platform/index.mjs'

export const HOST_NAME = 'io.bewly.download'

export function browserDirectories({ home = homedir(), kind = process.platform, env = process.env } = {}) {
  if (kind === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support')
    return ['Google/Chrome', 'Microsoft Edge', 'Chromium', 'BraveSoftware/Brave-Browser'].map(name => path.join(base, name, 'NativeMessagingHosts'))
  }
  const base = env.XDG_CONFIG_HOME || path.join(home, '.config')
  return ['google-chrome', 'microsoft-edge', 'chromium', 'BraveSoftware/Brave-Browser'].map(name => path.join(base, name, 'NativeMessagingHosts'))
}

export function manifestFor(launcher, origins) {
  return { name: HOST_NAME, description: 'Bewly local download core', path: launcher, type: 'stdio', allowed_origins: origins }
}

export function register({ root, launcher = platform.hostExecutable(root), home, kind, env } = {}) {
  if (!path.isAbsolute(launcher)) throw new Error('原生宿主路径必须是绝对路径')
  if (!existsSync(launcher)) throw new Error('原生宿主不存在，请重新安装下载助手')
  try { chmodSync(launcher, 0o755) } catch {}
  const identity = JSON.parse(readFileSync(path.join(root, 'identity.json'), 'utf8'))
  const origins = [...new Set([identity.extensionId, ...(identity.legacyExtensionIds || [])])].map(id => 'chrome-extension://' + id + '/')
  const written = []
  for (const directory of browserDirectories({ home, kind, env })) {
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, HOST_NAME + '.json')
    writeFileSync(file, JSON.stringify(manifestFor(launcher, origins), null, 2) + '\n', { mode: 0o644 })
    try { chmodSync(file, 0o644) } catch {}
    written.push(file)
  }
  return written
}

export function unregister({ home, kind, env } = {}) {
  const removed = []
  for (const directory of browserDirectories({ home, kind, env })) {
    const file = path.join(directory, HOST_NAME + '.json')
    if (!existsSync(file)) continue
    try { unlinkSync(file); removed.push(file) } catch {}
  }
  return removed
}
