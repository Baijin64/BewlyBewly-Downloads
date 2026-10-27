import { spawn } from 'node:child_process'
import { readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { platform } from '../platform/index.mjs'
import { prepareSupport, sanitizeEnv } from '../platform/common.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const nativeRoot = path.dirname(root)
const dataDirectory = platform.dataDirectory()
const connectorVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version

function readIdentity() {
  return JSON.parse(readFileSync(path.join(nativeRoot, 'identity.json'), 'utf8'))
}
function allowedOrigins() {
  const identity = readIdentity()
  return [...new Set([identity.extensionId, ...(identity.legacyExtensionIds || [])])].map(id => 'chrome-extension://' + id + '/')
}

// Chrome passes the caller origin as the first argument. Anything else must not
// receive a single byte on stdout (NativeHost.cs:96 returns 2 the same way).
const origin = process.argv[2]
if (!origin || !allowedOrigins().includes(origin)) process.exit(2)

function readExact(fd, length) {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const read = readSync(fd, buffer, offset, length - offset, null)
    if (read === 0) return null
    offset += read
  }
  return buffer
}
function readFrame() {
  const header = readExact(0, 4)
  if (!header) return null
  const length = header.readUInt32LE(0)
  if (length < 1 || length > 2 * 1024 * 1024) throw new Error('原生消息长度无效')
  const body = readExact(0, length)
  if (!body) throw new Error('原生消息不完整')
  return { header, body }
}

function writeFrame(reply) {
  const body = Buffer.from(JSON.stringify(reply))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  process.stdout.write(Buffer.concat([header, body]))
}

function handleBootstrap(id) {
  writeFrame({ ok: true, requestId: id, result: { connectorVersion, runtime: { ready: true, version: process.versions.node, architecture: process.arch, executable: process.execPath } } })
}

function handleSnapshot(id) {
  try {
    const file = path.join(dataDirectory, 'ui-snapshot.json')
    if (statSync(file).size > 900000) throw new Error('UI snapshot too large')
    writeFrame({ ok: true, requestId: id, result: JSON.parse(readFileSync(file, 'utf8')) })
  } catch {
    writeFrame({ ok: false, requestId: id, code: 'SNAPSHOT_MISSING', error: '本地配置将在首次启动助手时同步' })
  }
}

let first = readFrame()
while (first) {
  const message = JSON.parse(first.body.toString('utf8'))
  const id = message.requestId
  if (message.method === 'uiSnapshot') { handleSnapshot(id); first = readFrame(); continue }
  if (message.method === 'bootstrapStatus') { handleBootstrap(id); first = readFrame(); continue }
  break
}
if (!first) process.exit(0)

const environment = { ...sanitizeEnv(process.env), BEWLY_NODE_PATH: process.execPath }
const support = prepareSupport(nativeRoot, dataDirectory)
if (support) environment.CLASSIC_LEVEL_PREBUILD = support

const child = spawn(process.execPath, ['--no-warnings', path.join(nativeRoot, 'bridge.mjs')], {
  env: environment,
  stdio: ['pipe', 'pipe', 'pipe'],
})

// Replay the frame that ended the bootstrap loop, then let the pipes take over.
child.stdin.write(Buffer.concat([first.header, first.body]))
process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {})
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
process.stdout.on('error', () => {})
process.stdin.on('error', () => {})

let settled = false
const done = code => {
  if (settled) return
  settled = true
  process.exitCode = code
}
child.once('error', () => done(1))
child.once('exit', code => done(code ?? 0))
process.once('SIGTERM', () => { try { child.kill() } catch {} ; done(0) })
process.once('SIGINT', () => { try { child.kill() } catch {} ; done(0) })
