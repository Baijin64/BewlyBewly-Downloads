import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

import { detachedSpawn, killTree, prepareSupport, sanitizeEnv } from './common.mjs'

function which(name, env) {
  for (const directory of String(env.PATH || '').split(path.delimiter)) {
    if (directory && existsSync(path.join(directory, name))) return path.join(directory, name)
  }
  return ''
}

const FILTERS = {
  audio: '*.aac *.m4a *.m4s *.mp3 *.flac *.mka *.eac3 *.wav',
  video: '*.m4s *.mp4 *.mkv *.mov',
  cc: '*.json',
  srt: '*.srt',
  legacy: '*.bilidownexport',
}

export function createPlatform({ packageRoot = process.cwd(), spawnImpl = spawn, spawnSyncImpl = spawnSync, env = process.env } = {}) {
  const home = env.HOME || homedir()
  const picker = which('zenity', env) || which('kdialog', env)
  return {
    id: 'linux',
    supports: { tray: false, picker: Boolean(picker), clipboard: false, sound: false, shutdown: false, keychain: false },
    defaults: { headless: true, sessionFile: 'session' },
    dataDirectory() { return env.BEWLY_DOWNLOAD_DATA || path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'bewly-download') },
    legacyProfile() { return '' },
    hostExecutable(root) { return path.join(root, 'posix', 'launcher.sh') },
    helperBinary(root) { return path.join(root, 'posix', 'launcher.sh') },
    toolPath(bin, name) { return path.join(bin, name) },
    mediaSpawn(bin, name, args, options) { return spawnImpl(this.toolPath(bin, name), args, { ...options, detached: true }) },
    killTree,
    startService({ root, dataDirectory, mode }) {
      const child = detachedSpawn(process.execPath, ['--no-warnings', path.join(root, 'service-entry.mjs')], {
        ...sanitizeEnv(env),
        BEWLY_NODE_PATH: process.execPath,
        BEWLY_DOWNLOAD_DATA: dataDirectory,
        BEWLY_DOWNLOAD_MODE: mode === 'on-demand' ? 'on-demand' : 'manual',
        BEWLY_DOWNLOAD_HEADLESS: '1',
        CLASSIC_LEVEL_PREBUILD: prepareSupport(root, dataDirectory, 'linux'),
      })
      if (!child.pid) throw new Error('无法启动独立下载服务，请重新安装助手')
      return { pid: child.pid }
    },
    killPid(pid) { try { process.kill(pid) } catch {} },
    protectSecret(value) { return 'plain:' + Buffer.from(value, 'utf8').toString('base64') },
    unprotectSecret(blob) {
      if (!String(blob).startsWith('plain:')) throw new Error('无法读取本地登录信息')
      return Buffer.from(String(blob).slice(6), 'base64').toString('utf8')
    },
    sessionFileName() { return 'session' },
    pickPath(request) {
      if (!picker) return Promise.resolve({ path: null, cancelled: true, unavailable: true })
      const kind = request.kind || 'video'
      const start = typeof request.path === 'string' ? request.path : home
      const zenity = picker.endsWith('zenity')
      const args = kind === 'directory'
        ? (zenity ? ['--file-selection', '--directory', '--title=选择保存目录'] : ['--getexistingdirectory', start])
        : (zenity
          ? ['--file-selection', '--title=选择文件', '--file-filter=' + (FILTERS[kind] || '*')]
          : ['--getopenfilename', start, (FILTERS[kind] || '*') + '|文件'])
      return new Promise((resolve, reject) => {
        const child = spawnImpl(picker, args, { stdio: ['ignore', 'pipe', 'ignore'] })
        let output = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', chunk => { output += chunk })
        child.once('error', reject)
        child.once('exit', code => {
          if (code === 0 && output.trim()) resolve({ path: output.trim(), cancelled: false })
          else resolve({ path: null, cancelled: true })
        })
      })
    },
    openTarget({ kind, path: target }) {
      return new Promise((resolve, reject) => {
        const child = spawnImpl('xdg-open', [kind === 'reveal' ? path.dirname(target) : target], { stdio: 'ignore' })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve({ opened: true }) : reject(new Error('无法打开该位置')))
      })
    },
    shutdown() { spawnImpl('systemctl', ['poweroff'], { stdio: 'ignore' }) },
    startTray() { return undefined },
    isLegacyAppRunning() {
      const result = spawnSyncImpl('pgrep', ['-x', 'Bilidown'], { encoding: 'utf8' })
      return result.status === 0
    },
    installHint: '运行安装脚本后重启浏览器，或在终端执行 bewly-download-helper register',
    updateHint: '请更新下载助手',
  }
}
