import { execFileSync, spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

import { runJson } from './common.mjs'

const HOST = 'BewlyDownloadHost.exe'

export function createPlatform({ packageRoot = process.cwd(), spawnImpl = spawn, spawnSyncImpl = spawnSync, execFileSyncImpl = execFileSync, env = process.env } = {}) {
  const host = root => path.join(root, HOST)
  const callHost = (root, args, input) => {
    const result = spawnSyncImpl(host(root), args, { input, windowsHide: true, encoding: 'utf8', maxBuffer: 128 * 1024, env })
    if (result.status !== 0 || result.error) throw new Error('无法保护本地登录信息，请重新安装下载助手')
    return result.stdout.trim()
  }
  return {
    id: 'win32',
    supports: { tray: true, picker: true, clipboard: true, sound: true, shutdown: true, keychain: true },
    defaults: { headless: false, sessionFile: 'session.dpapi' },
    dataDirectory() { return env.BEWLY_DOWNLOAD_DATA || path.join(env.LOCALAPPDATA || packageRoot, 'BewlyDownload') },
    legacyProfile() { return path.join(env.APPDATA || '', 'bilidown') },
    hostExecutable(root) { return host(root) },
    helperBinary(root) { return host(root) },
    toolPath(bin, name) { return path.join(bin, name + '.exe') },
    mediaSpawn(bin, name, args, options) { return spawnImpl(host(path.dirname(bin)), ['--run-tool', name, ...args], options) },
    killTree(child) { try { child.kill() } catch {} },
    startService({ root, dataDirectory, mode }) {
      const result = spawnSyncImpl(host(root), ['--start-service', ...(mode === 'on-demand' ? ['--on-demand'] : [])], {
        windowsHide: true, encoding: 'utf8', env: { ...env, BEWLY_DOWNLOAD_DATA: dataDirectory }, timeout: 10000,
      })
      if (result.status !== 0 || result.error) throw new Error('无法启动独立下载服务，请重新安装助手')
      try { return { pid: JSON.parse(result.stdout).pid } } catch { throw new Error('下载服务启动结果无效') }
    },
    killPid(pid) { try { process.kill(pid) } catch {} },
    protectSecret(value) { return callHost(packageRoot, ['--protect'], value) },
    unprotectSecret(blob) { return callHost(packageRoot, ['--unprotect'], blob) },
    sessionFileName() { return 'session.dpapi' },
    pickPath(request) { return runJson(host(packageRoot), ['--desktop'], request) },
    openTarget(request) { return runJson(host(packageRoot), ['--open'], request) },
    shutdown() { spawnImpl('shutdown.exe', ['/s', '/t', '0'], { windowsHide: true, stdio: 'ignore' }) },
    startTray({ root }) { return spawnImpl(host(root), ['--tray'], { detached: true, windowsHide: true, stdio: 'ignore' }) },
    isLegacyAppRunning() {
      const processes = execFileSyncImpl('tasklist.exe', ['/FI', 'IMAGENAME eq Bilidown.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' })
      return /"bilidown\.exe"/i.test(processes)
    },
    installHint: '从 Windows 开始菜单打开一次下载助手完成连接',
    updateHint: '请更新 MSIX 安装包',
  }
}
