import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { homedir } from 'node:os'

import { detachedSpawn, killTree, prepareSupport, runJson, sanitizeEnv } from './common.mjs'

export function createPlatform({ packageRoot = process.cwd(), spawnImpl = spawn, spawnSyncImpl = spawnSync, env = process.env } = {}) {
  const home = env.HOME || homedir()
  const trayBinary = root => env.BEWLY_TRAY_BIN || path.join(root, 'BewlyTray')
  return {
    id: 'darwin',
    supports: { tray: true, picker: true, clipboard: true, sound: true, shutdown: true, keychain: true },
    defaults: { headless: false, sessionFile: 'session' },
    dataDirectory() { return env.BEWLY_DOWNLOAD_DATA || path.join(home, 'Library', 'Application Support', 'BewlyDownload') },
    legacyProfile() { return path.join(home, 'Library', 'Application Support', 'bilidown') },
    hostExecutable(root) { return path.join(root, 'posix', 'launcher.sh') },
    helperBinary(root) { return trayBinary(root) },
    toolPath(bin, name) { return path.join(bin, name) },
    mediaSpawn(bin, name, args, options) { return spawnImpl(this.toolPath(bin, name), args, { ...options, detached: true }) },
    killTree,
    startService({ root, dataDirectory, mode }) {
      const child = detachedSpawn(process.execPath, ['--no-warnings', path.join(root, 'service-entry.mjs')], {
        ...sanitizeEnv(env),
        BEWLY_NODE_PATH: process.execPath,
        BEWLY_DOWNLOAD_DATA: dataDirectory,
        BEWLY_DOWNLOAD_MODE: mode === 'on-demand' ? 'on-demand' : 'manual',
        CLASSIC_LEVEL_PREBUILD: prepareSupport(root, dataDirectory, 'darwin'),
      })
      if (!child.pid) throw new Error('无法启动独立下载服务，请重新安装助手')
      return { pid: child.pid }
    },
    killPid(pid) { try { process.kill(pid) } catch {} },
    protectSecret(value) {
      try {
        const result = spawnSyncImpl('security', ['add-generic-password', '-U', '-a', 'bewly', '-s', 'io.bewly.download.session', '-w', value], { encoding: 'utf8' })
        if (result.status !== 0) throw new Error('keychain unavailable')
        return 'keychain:io.bewly.download.session'
      } catch {
        return 'plain:' + Buffer.from(value, 'utf8').toString('base64')
      }
    },
    unprotectSecret(blob) {
      if (String(blob).startsWith('plain:')) return Buffer.from(String(blob).slice(6), 'base64').toString('utf8')
      const result = spawnSyncImpl('security', ['find-generic-password', '-a', 'bewly', '-s', 'io.bewly.download.session', '-w'], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error('无法读取本地登录信息')
      return String(result.stdout).replace(/\n$/, '')
    },
    sessionFileName() { return 'session' },
    pickPath(request) { return runJson(trayBinary(packageRoot), ['--pick'], request) },
    openTarget({ kind, path: target }) {
      return new Promise((resolve, reject) => {
        const args = kind === 'reveal' ? ['-R', target] : [target]
        const child = spawnImpl('open', args, { stdio: 'ignore' })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve({ opened: true }) : reject(new Error('无法打开该位置')))
      })
    },
    shutdown() { spawnImpl('osascript', ['-e', 'tell application "System Events" to shut down'], { stdio: 'ignore' }) },
    startTray({ root, dataDirectory }) { return detachedSpawn(trayBinary(root), ['--tray', dataDirectory], sanitizeEnv(env)) },
    isLegacyAppRunning() {
      const result = spawnSyncImpl('pgrep', ['-x', 'Bilidown'], { encoding: 'utf8' })
      return result.status === 0
    },
    installHint: '打开「Bewly 下载助手」一次完成连接（首次需在系统设置中允许打开）',
    updateHint: '请更新下载助手',
  }
}
