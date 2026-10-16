import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { safeName, srtText, toSrt } from './formats.mjs'

const alphabet = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'
export function convertVideoId(input) {
  const text = String(input).trim()
  if (/^av[1-9]\d*$/i.test(text) || /^[1-9]\d*$/.test(text)) {
    const aid = BigInt(text.replace(/^av/i, ''))
    if (aid >= (1n << 51n)) throw new Error('AV 号超出支持范围')
    let number = ((1n << 51n) | aid) ^ 23442827791579n
    const chars = Array.from('BV1000000000')
    for (let index = 11; number; index--) { chars[index] = alphabet[Number(number % 58n)]; number /= 58n }
    ;[chars[3], chars[9]] = [chars[9], chars[3]]
    ;[chars[4], chars[7]] = [chars[7], chars[4]]
    return chars.join('')
  }
  if (!/^BV1[0-9A-Za-z]{9}$/.test(text)) throw new Error('请输入 BV 或 AV 号')
  const chars = Array.from(text)
  ;[chars[3], chars[9]] = [chars[9], chars[3]]
  ;[chars[4], chars[7]] = [chars[7], chars[4]]
  let number = 0n
  for (const char of chars.slice(3)) {
    const index = alphabet.indexOf(char)
    if (index < 0) throw new Error('BV 号包含无效字符')
    number = number * 58n + BigInt(index)
  }
  const aid = (number & 2251799813685247n) ^ 23442827791579n
  if (convertVideoId('av' + aid) !== text) throw new Error('BV 号校验失败')
  return 'av' + aid
}

export async function desktop(root, mode, params, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'BewlyDownloadHost.exe'), [mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal })
    let output = '', error = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-1000) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) { reject(new Error(error || 'Windows 操作失败')); return }
      try { resolve(JSON.parse(output)) } catch { reject(new Error('Windows 助手返回了无效结果')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(params))
  })
}

async function sourceFile(value, extensions) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !extensions.includes(path.extname(value).toLowerCase())) throw new Error('请选择支持的本地文件')
  if (!(await stat(value)).isFile()) throw new Error('源文件不存在')
  return value
}

export class ToolJobs {
  constructor({ store, queue, root, bilibili }) {
    Object.assign(this, { store, queue, root, bilibili })
    this.running = new Map()
    store.db.exec('CREATE TABLE IF NOT EXISTS tool_jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL)')
    for (const row of store.db.prepare('SELECT id,data FROM tool_jobs').all()) {
      const job = JSON.parse(row.data)
      if (job.status === 'running') this.put({ ...job, status: 'failed', error: '助手重启中断了工具操作，请重试' })
    }
  }
  put(job) {
    this.store.db.prepare('INSERT INTO tool_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job))
    return job
  }
  async request(params) {
    if (params.op === 'status') {
      const row = this.store.db.prepare('SELECT data FROM tool_jobs WHERE id=?').get(String(params.id))
      if (!row) throw new Error('工具任务不存在')
      return JSON.parse(row.data)
    }
    if (params.op === 'cancel') { this.running.get(params.id)?.abort(); return { cancelled: true } }
    if (!['pick', 'convertId', 'joinTime', 'ccToSrt', 'srtToText', 'audioToMp3', 'mux', 'exportHistory'].includes(params.op)) throw new Error('未知辅助工具')
    if (this.running.size >= 4) throw new Error('辅助工具运行过多，请先完成或取消已有操作')
    const job = this.put({ id: randomUUID(), status: 'running', operation: params.op, createdAt: new Date().toISOString() })
    const controller = new AbortController()
    this.running.set(job.id, controller)
    this.execute(params, AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60000)])).then(result => this.put({ ...job, status: 'completed', result }), error => this.put({ ...job, status: 'failed', error: error.message })).finally(() => this.running.delete(job.id))
    return job
  }
  async execute(params, signal) {
    if (params.op === 'pick') return desktop(this.root, '--desktop', { kind: params.kind, path: params.path }, signal)
    if (params.op === 'convertId') return { text: convertVideoId(params.input) }
    if (params.op === 'joinTime') {
      const data = await this.bilibili.api('https://member.bilibili.com/x2/creative/h5/calendar/event', { ts: '0' }, signal)
      const joined = data.pfs?.profile?.jointime
      if (!joined) throw new Error('官方接口当前未提供该账号的入站时间，请确认已登录')
      return { text: new Date(Number(joined) * 1000).toLocaleString('zh-CN') }
    }
    const directory = params.directory || this.store.settings().directory
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择输出目录')
    let args, target, text
    if (params.op === 'exportHistory') {
      const downloaded = this.store.list().filter(task => task.status === 'completed').map(task => ({
        vid: task.id, uid: task.uid || 0, upname: task.author || '', title: task.title, bv: task.bvid,
        pic: task.cover || '', path: task.legacyPath || (task.output ? path.dirname(task.output) : task.directory),
        downDate: task.completedAt || task.updatedAt, type: task.legacyType || (task.options?.outputs || []).join(' / '),
      }))
      if (!downloaded.length) throw new Error('没有可导出的已完成记录')
      text = JSON.stringify({ downloaded }).split('').map(char => String.fromCharCode(char.charCodeAt(0) ^ 54)).join('')
      target = path.join(directory, 'bewly_history_' + new Date().toISOString().slice(0, 10) + '-' + randomUUID().slice(0, 8) + '.bilidownexport')
    }
    else if (params.op === 'ccToSrt' || params.op === 'srtToText') {
      const source = await sourceFile(params.source, params.op === 'ccToSrt' ? ['.json'] : ['.srt'])
      if ((await stat(source)).size > 10 * 1024 * 1024) throw new Error('字幕文件超过 10 MB')
      const content = await readFile(source, 'utf8')
      text = params.op === 'ccToSrt' ? toSrt(JSON.parse(content.replace(/^\uFEFF/, '')).body) : srtText(content, params.lineBreaks !== false)
      target = path.join(directory, safeName(path.basename(source, path.extname(source))) + (params.op === 'ccToSrt' ? '.srt' : params.lineBreaks === false ? '.joined.txt' : '.txt'))
    }
    else if (params.op === 'audioToMp3') {
      const source = await sourceFile(params.source, ['.aac', '.m4a', '.m4s', '.mp3', '.flac', '.mka', '.eac3', '.wav'])
      target = path.join(directory, safeName(path.basename(source, path.extname(source))) + '.mp3')
      args = ['-i', source, '-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '2']
    }
    else {
      const video = await sourceFile(params.video, ['.mp4', '.m4s', '.mkv', '.mov'])
      const audio = await sourceFile(params.audio, ['.aac', '.m4a', '.m4s', '.mp3', '.flac', '.mka', '.eac3', '.wav'])
      target = path.join(directory, safeName(path.basename(video, path.extname(video))) + '.merged.mkv')
      args = ['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy']
    }
    if (existsSync(target)) throw new Error('输出文件已存在，已保留原文件')
    await mkdir(directory, { recursive: true })
    const temporary = path.join(directory, '.bewly-tool-' + randomUUID() + path.extname(target))
    try {
      if (args) await this.queue.ffmpeg([...args, temporary], signal)
      else await writeFile(temporary, text)
      signal.throwIfAborted()
      const reserved = await open(target, 'wx'); await reserved.close()
      try { await rename(temporary, target) } catch (error) { await unlink(target).catch(() => {}); throw error }
    } finally { await unlink(temporary).catch(() => {}) }
    return { path: target }
  }
  async close() {
    for (const controller of this.running.values()) controller.abort()
    while (this.running.size) await new Promise(resolve => setTimeout(resolve, 20))
  }
}
