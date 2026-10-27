import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { createPlatform as createDarwin } from '../platform/darwin.mjs'
import { createPlatform as createLinux } from '../platform/linux.mjs'
import { createPlatform as createWin32 } from '../platform/win32.mjs'

function recorder() {
  const calls = []
  const spawn = (command, args, options) => { calls.push({ kind: 'spawn', command, args, options }); return { pid: 4242, once() {}, unref() {} } }
  const spawnSync = (command, args, options) => {
    calls.push({ kind: 'spawnSync', command, args, options })
    if (args.includes('--start-service')) return { status: 0, stdout: JSON.stringify({ pid: 5151 }) }
    return { status: 0, stdout: ' protected-token \n' }
  }
  const execFileSync = () => 'INFO: No tasks are running which match the specified criteria.'
  return { calls, spawn, spawnSync, execFileSync }
}

test('win32 adapter keeps the exact host invocation contract', () => {
  const tools = recorder()
  const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }
  const platform = createWin32({ packageRoot: 'C:\\app\\native', spawnImpl: tools.spawn, spawnSyncImpl: tools.spawnSync, execFileSyncImpl: tools.execFileSync, env })
  assert.equal(platform.dataDirectory(), path.join(env.LOCALAPPDATA, 'BewlyDownload'))
  assert.equal(platform.sessionFileName(), 'session.dpapi')
  assert.deepEqual(platform.supports, { tray: true, picker: true, clipboard: true, sound: true, shutdown: true, keychain: true })

  const media = platform.mediaSpawn('C:\\app\\native\\bin', 'aria2c', ['--version'], { windowsHide: true, stdio: 'ignore' })
  assert.equal(media.pid, 4242)
  assert.deepEqual(tools.calls.at(-1).command, path.join('C:\\app\\native', 'BewlyDownloadHost.exe'))
  assert.deepEqual(tools.calls.at(-1).args, ['--run-tool', 'aria2c', '--version'])

  assert.deepEqual(platform.startService({ root: 'C:\\app\\native', dataDirectory: 'C:\\data', mode: 'on-demand' }), { pid: 5151 })
  const start = tools.calls.at(-1)
  assert.deepEqual(start.args, ['--start-service', '--on-demand'])
  assert.equal(start.options.timeout, 10000)
  assert.equal(start.options.env.BEWLY_DOWNLOAD_DATA, 'C:\\data')

  assert.equal(platform.protectSecret('cookie'), 'protected-token')
  assert.deepEqual(tools.calls.at(-1).args, ['--protect'])
  assert.equal(tools.calls.at(-1).options.input, 'cookie')

  platform.startTray({ root: 'C:\\app\\native' })
  assert.deepEqual(tools.calls.at(-1).args, ['--tray'])
  assert.equal(tools.calls.at(-1).options.detached, true)

  platform.shutdown()
  assert.equal(tools.calls.at(-1).command, 'shutdown.exe')
  assert.deepEqual(tools.calls.at(-1).args, ['/s', '/t', '0'])

  assert.equal(platform.isLegacyAppRunning(), false)
  assert.equal(path.basename(platform.toolPath('C:\\bin', 'ffmpeg')), 'ffmpeg.exe')
})

test('posix adapters expose distinct capabilities and paths', () => {
  const tools = recorder()
  const darwin = createDarwin({ packageRoot: '/Applications/Bewly.app/Contents/Resources/native', spawnImpl: tools.spawn, spawnSyncImpl: tools.spawnSync, env: { HOME: '/Users/x' } })
  assert.equal(darwin.dataDirectory(), path.join('/Users/x', 'Library', 'Application Support', 'BewlyDownload'))
  assert.equal(darwin.hostExecutable('/app/native'), path.join('/app/native', 'posix', 'launcher.sh'))
  assert.equal(darwin.toolPath('/app/native/bin', 'aria2c'), path.join('/app/native/bin', 'aria2c'))
  assert.equal(darwin.supports.tray, true)
  assert.equal(darwin.supports.keychain, true)

  const linux = createLinux({ packageRoot: '/opt/bewly', spawnImpl: tools.spawn, spawnSyncImpl: tools.spawnSync, env: { HOME: '/home/x', PATH: '' } })
  assert.equal(linux.dataDirectory(), path.join('/home/x', '.local', 'share', 'bewly-download'))
  assert.equal(linux.toolPath('/opt/bewly/bin', 'ffmpeg'), path.join('/opt/bewly/bin', 'ffmpeg'))
  assert.equal(linux.supports.tray, false)
  assert.equal(linux.supports.picker, false)
  assert.equal(linux.supports.shutdown, false)
  assert.equal(linux.defaults.headless, true)
})

test('linux respects XDG_DATA_HOME and reports the picker capability', async () => {
  const tools = recorder()
  const linux = createLinux({ packageRoot: '/opt/bewly', spawnImpl: tools.spawn, spawnSyncImpl: tools.spawnSync, env: { HOME: '/home/x', XDG_DATA_HOME: '/home/x/.xdg', PATH: '' } })
  assert.equal(linux.dataDirectory(), path.join('/home/x/.xdg', 'bewly-download'))
  assert.deepEqual(await linux.pickPath({ kind: 'directory' }), { path: null, cancelled: true, unavailable: true })
})

test('linux picker uses zenity when present and maps cancellation', async () => {
  const emitted = []
  const spawn = (command, args) => {
    emitted.push({ command, args })
    const handlers = {}
    const child = { stdout: { setEncoding() {}, on() {} }, once(event, handler) { handlers[event] = handler; if (event === 'exit') setTimeout(() => handler(1), 0) }, kill() {} }
    return child
  }
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-picker-'))
  writeFileSync(path.join(directory, 'zenity'), '')
  const linux = createLinux({ spawnImpl: spawn, spawnSyncImpl: () => ({ status: 1 }), env: { HOME: '/home/x', PATH: directory } })
  assert.equal(linux.supports.picker, true)
  assert.deepEqual(await linux.pickPath({ kind: 'directory' }), { path: null, cancelled: true })
  assert.deepEqual(emitted.at(-1).args.slice(0, 2), ['--file-selection', '--directory'])
})

test('darwin secrets fall back to a plain token when the keychain is unavailable', () => {
  const platform = createDarwin({ spawnImpl: () => ({}), spawnSyncImpl: () => ({ status: 1 }), env: { HOME: '/Users/x' } })
  const stored = platform.protectSecret('SESSDATA=abc')
  assert.match(stored, /^plain:/)
  assert.equal(platform.unprotectSecret(stored), 'SESSDATA=abc')
})
