import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const installedRoot = process.argv[2]
assert.ok(installedRoot && path.isAbsolute(installedRoot) && installedRoot.includes('WindowsApps'))
const alias = path.join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps/BewlyDownloadHost.exe')
const identity = JSON.parse(await readFile('platforms/identity.json', 'utf8'))
const version = /\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/.exec(await readFile('rust/Cargo.toml', 'utf8'))[1]
const directory = await mkdtemp(path.join(tmpdir(), 'bewly-installed-runtime-'))
const data = path.join(directory, 'data')
const env = { ...process.env, BEWLY_DOWNLOAD_DATA: data, BEWLY_DOWNLOAD_HEADLESS: '1' }
let started = false
let cleanupError = null

function frame(value) {
  const body = Buffer.from(JSON.stringify(value))
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(body.length)
  return Buffer.concat([prefix, body])
}

async function rpc(method, params = {}) {
  const connection = JSON.parse(await readFile(path.join(data, 'connection.json'), 'utf8'))
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: connection.port,
      path: '/rpc',
      method: 'POST',
      agent: false,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          const value = JSON.parse(body)
          assert.equal(value.ok, true)
          resolve(value.result)
        }
        catch (error) {
          reject(error)
        }
      })
    })
    request.setTimeout(10000, () => request.destroy(new Error('Isolated service timed out')))
    request.on('error', reject)
    request.end(JSON.stringify({ method, params }))
  })
}

try {
  assert.equal(existsSync(path.join(installedRoot, 'runtime/node.exe')), false, 'Rust helper must not ship node.exe')
  assert.equal(existsSync(path.join(installedRoot, 'bin/aria2c.exe')), false, 'Rust helper must not ship aria2c.exe')
  const bundledFfmpeg = path.join(installedRoot, 'bin/ffmpeg.exe')
  assert.equal(existsSync(bundledFfmpeg), true, 'bundled bin/ffmpeg.exe must be present')
  assert.equal(existsSync(path.join(installedRoot, 'BewlyDownloadTray.exe')), true, 'BewlyDownloadTray.exe must be present')

  const hostVersion = spawnSync(alias, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 10000 })
  assert.equal(hostVersion.status, 0, hostVersion.stderr)
  assert.match(hostVersion.stdout, /^bewly-host \d/)

  const response = spawnSync(alias, [`chrome-extension://${identity.extensionId}/`], { env, input: frame({ method: 'health', requestId: 1, allowStart: true }), windowsHide: true, timeout: 20000 })
  assert.equal(response.status, 0, response.stderr.toString())
  const healthReply = JSON.parse(response.stdout.subarray(4))
  assert.equal(healthReply.ok, true)
  assert.equal(healthReply.result.version, version)
  started = true

  const source = path.join(directory, '原始音频.wav')
  execFileSync(bundledFfmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.25', source], { windowsHide: true })
  const task = await rpc('tool', { op: 'audioToMp3', source, directory: path.join(directory, 'output') })
  let result
  for (let n = 0; n < 80; n++) {
    result = await rpc('tool', { op: 'status', id: task.id })
    if (result.status !== 'running')
      break
    await delay(100)
  }
  assert.equal(result.status, 'completed', result.error)
  const mp3Bytes = (await stat(result.result.path)).size
  assert.ok(mp3Bytes > 0)

  const report = {
    checkedAt: new Date().toISOString(),
    helperVersion: version,
    hostVersionOutput: hostVersion.stdout.trim(),
    installedAliasPipeReleased: true,
    bundledNodeAbsent: true,
    bundledAria2Absent: true,
    bundledFfmpegPresent: true,
    installedRustServiceVerified: true,
    installedFfmpegMp3Verified: true,
    outputBytes: mp3Bytes,
    productionDataTouched: false,
  }
  await writeFile(`dist/installed-runtime-${version}-verification.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
}
finally {
  if (started || existsSync(path.join(data, 'connection.json'))) {
    try {
      await rpc('desktopAction', { action: 'exit' })
    }
    catch {}
    for (let n = 0; n < 60 && existsSync(path.join(data, 'connection.json')); n++)
      await delay(100)
    if (existsSync(path.join(data, 'connection.json')))
      cleanupError = new Error('Isolated installed service did not stop; leaving its own files for inspection')
  }
  if (!cleanupError) {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('bewly-installed-runtime-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
}

if (cleanupError)
  throw cleanupError
