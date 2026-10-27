import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { isCompatible, parseShasums, probeNode, resolveNode } from './node-resolver.mjs'

const SHASUMS_URL = 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt'
const LIMIT = 128 * 1024 * 1024

function request(url) {
  const address = new URL(url)
  if (address.protocol !== 'https:' || address.hostname !== 'nodejs.org' || address.port) throw new Error('安装程序地址无效')
  return fetch(address, { redirect: 'error' })
}

// Picks the newest Node 24 tarball for this target from the signed checksum list.
export function latestFor(shasums, platform = process.platform, arch = process.arch) {
  if (!['darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) return null
  const suffix = '-' + platform + '-' + arch + '.tar.gz'
  for (const line of String(shasums).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(node-v(24\.\d+\.\d+)-[a-z0-9]+-[a-z0-9]+\.tar\.gz)$/.exec(line.trim())
    if (!match) continue
    const filename = match[2]
    if (!filename.endsWith(suffix)) continue
    return { version: match[3], filename, sha256: match[1].toLowerCase() }
  }
  return null
}

async function download(url, destination, expected, onProgress) {
  const response = await request(url)
  if (!response.ok || !response.body) throw new Error('无法下载 Node.js 安装包（HTTP ' + response.status + '）')
  const length = Number(response.headers.get('content-length') || 0)
  if (length > LIMIT) throw new Error('Node.js 安装包大小异常')
  const hash = createHash('sha256')
  let total = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', chunk => {
    total += chunk.length
    if (total > LIMIT) source.destroy(new Error('Node.js 安装包大小异常'))
    hash.update(chunk)
    if (onProgress && length) onProgress(Math.round(total * 100 / length))
  })
  await pipeline(source, createWriteStream(destination, { mode: 0o600 }))
  if (hash.digest('hex') !== expected) throw new Error('Node.js 安装包校验失败，请重试')
  return total
}

export async function ensureNode({ dataDirectory, platform = process.platform, arch = process.arch, onProgress, log = () => {} } = {}) {
  if (platform === 'win32') throw new Error('Windows 使用 MSIX 安装程序管理 Node.js')
  const existing = resolveNode({ dataDirectory, platform, arch })
  if (existing.ready) return existing

  log('正在获取 Node.js 官方发布清单…')
  const listed = await request(SHASUMS_URL)
  if (!listed.ok) throw new Error('无法获取 Node.js 发布清单（HTTP ' + listed.status + '）')
  const text = await listed.text()
  if (text.length > 128 * 1024) throw new Error('Node.js 发布清单大小异常')
  const release = latestFor(text, platform, arch)
  if (!release) throw new Error('官方发布清单中没有匹配的 Node.js 24 安装包')
  if (parseShasums(text, release.filename) !== release.sha256) throw new Error('官方发布清单校验行不一致')

  const runtimeRoot = path.join(dataDirectory, 'runtime')
  const staging = path.join(runtimeRoot, '.staging-' + process.pid + '-' + Date.now())
  const archive = path.join(staging, release.filename)
  mkdirSync(staging, { recursive: true })
  try {
    log(`正在下载 Node.js ${release.version}（${platform}-${arch}）…`)
    await download('https://nodejs.org/dist/v' + release.version + '/' + release.filename, archive, release.sha256, onProgress)
    log('正在解压…')
    const extracted = path.join(staging, 'node')
    mkdirSync(extracted, { recursive: true })
    const untar = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', extracted], { encoding: 'utf8' })
    if (untar.status !== 0) throw new Error('解压 Node.js 失败：' + (untar.stderr || untar.status))
    const executable = path.join(extracted, 'bin', 'node')
    if (!existsSync(executable) || statSync(executable).size === 0) throw new Error('Node.js 安装包缺少可执行文件')
    chmodSync(executable, 0o755)
    const report = probeNode(executable)
    if (!isCompatible(report, { platform, arch })) throw new Error('下载的 Node.js 与当前架构不匹配')
    const target = path.join(runtimeRoot, 'node')
    await rm(target, { recursive: true, force: true })
    renameSync(extracted, target)
    writeFileSync(path.join(runtimeRoot, 'runtime.json'), JSON.stringify({
      version: release.version, arch, sha256: release.sha256, source: 'https://nodejs.org/dist/v' + release.version + '/' + release.filename, installedAt: new Date().toISOString(),
    }, null, 2) + '\n')
    return { ready: true, executable: path.join(target, 'bin', 'node'), version: release.version, architecture: arch, source: 'managed' }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

export function installedRuntime(dataDirectory) {
  try { return JSON.parse(readFileSync(path.join(dataDirectory, 'runtime', 'runtime.json'), 'utf8')) } catch { return null }
}
