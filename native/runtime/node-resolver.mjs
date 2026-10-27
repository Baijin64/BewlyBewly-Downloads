import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

// The probe really opens an in-memory SQLite database: `node:sqlite` is the hard
// floor at Node 24, and a version string alone cannot prove the API works.
const PROBE = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE t(x)');db.close();process.stdout.write(JSON.stringify({version:process.versions.node,arch:process.arch,fetch:typeof fetch==='function',abort:typeof AbortSignal.timeout==='function'})`

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''))
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: `${match[1]}.${match[2]}.${match[3]}` }
}

export function isCompatible(report, { platform = process.platform, arch = process.arch } = {}) {
  if (!report) return false
  const version = parseVersion(report.version)
  if (!version || version.major < 24) return false
  if (platform === 'win32' ? report.arch !== 'x64' : report.arch !== arch) return false
  return report.fetch === true && report.abort === true
}

export function tarballFor(version, platform, arch) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('当前平台不支持自动安装 Node.js')
  if (!['x64', 'arm64'].includes(arch)) throw new Error('不支持的 CPU 架构：' + arch)
  return `node-v${version}-${platform}-${arch}.tar.gz`
}

export function parseShasums(text, filename) {
  const pattern = new RegExp('^([0-9a-fA-F]{64})\\s+\\*?' + filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm')
  const match = pattern.exec(String(text))
  return match ? match[1].toLowerCase() : ''
}

export function candidates({ env = process.env, dataDirectory, platform = process.platform, arch = process.arch } = {}) {
  const list = []
  const push = (executable, source) => {
    if (!executable || !path.isAbsolute(executable) || !existsSync(executable)) return
    if (list.some(item => item.executable === executable)) return
    list.push({ executable, source })
  }
  push(env.BEWLY_NODE_PATH, 'env')
  if (dataDirectory) push(path.join(dataDirectory, 'runtime', 'node', 'bin', 'node'), 'managed')
  for (const directory of String(env.PATH || '').split(path.delimiter)) push(directory && path.join(directory, 'node'), 'path')
  if (platform === 'darwin') for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) push(candidate, 'system')
  if (platform === 'linux') for (const candidate of ['/usr/local/bin/node', '/usr/bin/node']) push(candidate, 'system')
  const home = env.HOME || ''
  if (home) {
    const nvm = env.NVM_DIR || path.join(home, '.nvm')
    for (const version of nvmVersions(nvm)) push(path.join(nvm, 'versions', 'node', version, 'bin', 'node'), 'nvm')
    push(path.join(home, '.volta', 'bin', 'node'), 'volta')
    push(path.join(home, '.asdf', 'shims', 'node'), 'asdf')
    push(path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'), 'fnm')
  }
  return { arch, list }
}

function nvmVersions(directory) {
  try {
    return readdirSync(directory).filter(name => /^v\d+\./.test(name)).sort((a, b) => Number(b.slice(1).split('.')[0]) - Number(a.slice(1).split('.')[0]))
  } catch { return [] }
}

export function probeNode(executable, { timeout = 3500, env = process.env } = {}) {
  const result = spawnSync(executable, ['--no-warnings', '-e', PROBE], {
    encoding: 'utf8', timeout, windowsHide: true,
    env: { ...env, NODE_OPTIONS: '', NODE_PATH: '' },
  })
  if (result.status !== 0 || !result.stdout) return null
  try {
    const report = JSON.parse(result.stdout.trim())
    return { ...report, executable }
  } catch { return null }
}

export function resolveNode(options = {}) {
  const { env = process.env, dataDirectory, platform = process.platform, arch = process.arch, limit = 8, budget = 7000, probe = probeNode } = options
  const started = Date.now()
  const { list } = candidates({ env, dataDirectory, platform, arch })
  let last = null
  for (const candidate of list.slice(0, limit)) {
    if (Date.now() - started > budget) break
    const report = probe(candidate.executable, { env })
    if (!report) continue
    last = report
    if (isCompatible(report, { platform, arch })) return { ready: true, executable: candidate.executable, version: report.version, architecture: report.arch, source: candidate.source }
  }
  const reason = last
    ? `需要 Node.js 24 或更新版本（当前 ${last.version} / ${last.arch}），请重新运行安装程序自动安装`
    : '未找到 Node.js 24 或更新版本，请重新运行安装程序自动安装'
  return { ready: false, reason, version: last?.version, architecture: last?.arch }
}
