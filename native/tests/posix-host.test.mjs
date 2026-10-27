import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { nativeRoot } from './support/host.mjs'

const host = path.join(nativeRoot, 'posix', 'host.mjs')
const identity = JSON.parse(readFileSync(path.join(nativeRoot, 'identity.json'), 'utf8'))
const origin = `chrome-extension://${identity.extensionId}/`

function frame(value) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}
function parseFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    assert.ok(buffer.length >= offset + 4, 'truncated frame header')
    const length = buffer.readUInt32LE(offset)
    assert.ok(buffer.length >= offset + 4 + length, 'truncated frame body')
    frames.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length)))
    offset += 4 + length
  }
  return frames
}

function runHost({ input = Buffer.alloc(0), env = {}, caller = origin, chunked = false, timeout = 15000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--no-warnings', host, caller], {
      env: { ...process.env, BEWLY_DOWNLOAD_HEADLESS: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = [], err = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeout)
    child.once('exit', code => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
    })
    if (!chunked) {
      child.stdin.end(input)
      return
    }
    let remaining = input
    const pump = async () => {
      while (remaining.length) {
        child.stdin.write(remaining.subarray(0, 1))
        remaining = remaining.subarray(1)
        await delay(1)
      }
      child.stdin.end()
    }
    pump()
  })
}

test('posix host answers bootstrapStatus and preserves request ids', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-posix-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const input = Buffer.concat([frame({ method: 'bootstrapStatus', requestId: 11 }), frame({ method: 'bootstrapStatus', requestId: 12 })])
  const result = await runHost({ input, env: { BEWLY_DOWNLOAD_DATA: path.join(directory, 'data') } })
  assert.equal(result.code, 0, result.stderr)
  const frames = parseFrames(result.stdout)
  assert.deepEqual(frames.map(item => item.requestId), [11, 12])
  assert.ok(frames.every(item => item.ok === true))
  assert.equal(frames[0].result.runtime.ready, true)
  assert.equal(frames[0].result.runtime.executable, process.execPath)
  assert.equal(frames[0].result.connectorVersion, JSON.parse(readFileSync(path.join(nativeRoot, 'package.json'), 'utf8')).version)
})

test('posix host tolerates frames split into single bytes', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-posix-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const input = frame({ method: 'bootstrapStatus', requestId: 'split' })
  const result = await runHost({ input, chunked: true, env: { BEWLY_DOWNLOAD_DATA: path.join(directory, 'data') } })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(parseFrames(result.stdout)[0].requestId, 'split')
})

test('posix host rejects foreign origins without writing to stdout', async () => {
  const result = await runHost({ caller: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' })
  assert.equal(result.code, 2)
  assert.equal(result.stdout.length, 0)
})

test('posix host reports a missing snapshot and never creates the data directory', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-posix-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const data = path.join(directory, 'data')
  const result = await runHost({ input: frame({ method: 'uiSnapshot', requestId: 7 }), env: { BEWLY_DOWNLOAD_DATA: data } })
  assert.equal(result.code, 0, result.stderr)
  const [reply] = parseFrames(result.stdout)
  assert.equal(reply.code, 'SNAPSHOT_MISSING')
  assert.equal(reply.requestId, 7)
  assert.equal(existsSync(data), false)
})

test('posix host returns an existing snapshot verbatim', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-posix-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const data = path.join(directory, 'data')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(data, { recursive: true })
  writeFileSync(path.join(data, 'ui-snapshot.json'), JSON.stringify({ health: { version: '0.2.8' }, items: [], counts: { pending: 0 } }))
  const result = await runHost({ input: frame({ method: 'uiSnapshot', requestId: 8 }), env: { BEWLY_DOWNLOAD_DATA: data } })
  const [reply] = parseFrames(result.stdout)
  assert.equal(reply.ok, true)
  assert.equal(reply.result.health.version, '0.2.8')
})

test('posix host rejects an oversized frame header', async () => {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(2 * 1024 * 1024 + 1)
  const result = await runHost({ input: header })
  assert.notEqual(result.code, 0)
})
