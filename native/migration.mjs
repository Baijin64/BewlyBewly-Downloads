import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { ClassicLevel } from 'classic-level'

import { validateOptions } from './formats.mjs'

const keys = new Set(['setting', 'defaultDownPath', 'renameRule', 'folderRenameRule', 'createFolder', 'createFolderAddIndex'])
function chromiumString(value) {
  const bytes = Buffer.from(value)
  if (bytes[0] === 0) return bytes.subarray(1).toString('utf16le')
  if (bytes[0] === 1) return bytes.subarray(1).toString('latin1')
  throw new Error('不支持的旧版字符串编码')
}
export function mapLegacySettings(values) {
  const setting = JSON.parse(values.setting || '{}')
  const options = validateOptions({
    quality: Number(setting.videoQn || 0),
    audioQuality: ({ dubi: 'dolby', hi: 'hires' })[setting.audioQn] || String(setting.audioQn || 'auto'),
    codec: ({ avc1: 'avc', av01: 'av1', hev1: 'hevc', hvc1: 'hevc' })[setting.videoEncoding] || 'auto',
    outputs: ['video'],
    filenameTemplate: values.renameRule || '%title%',
    folderTemplate: values.folderRenameRule || '',
    createFolder: values.createFolder === 'true', createFolderAddIndex: values.createFolderAddIndex === 'true',
  })
  const settings = { defaultOptions: options, maxConcurrent: Math.max(1, Math.min(4, Number(setting.maxDownCount) || 1)),
    features: { cover: setting.pic === true, audio: setting.music === true, xml: setting.xml === true, ass: setting.ass === true, nfo: setting.guaxiao === true, srt: setting.zimu === true, tools: setting.tools === true },
    soundTip: setting.soundTip !== false,
    shutdown: false, listenClipboard: false,
  }
  if (values.defaultDownPath && path.isAbsolute(values.defaultDownPath)) settings.directory = values.defaultDownPath
  return settings
}

export async function readLegacySettings(profile, dataDirectory, { checkRunning = true } = {}) {
  if (checkRunning && process.platform === 'win32') {
    const processes = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Bilidown.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' })
    if (/"bilidown\.exe"/i.test(processes)) throw new Error('请先退出旧版 Bilidown，再读取配置，避免复制到使用中的数据库')
  }
  const source = path.join(profile, 'Local Storage', 'leveldb')
  if (!existsSync(path.join(source, 'CURRENT'))) throw new Error('没有找到旧版 Bilidown 配置')
  await mkdir(dataDirectory, { recursive: true })
  const snapshot = await mkdtemp(path.join(dataDirectory, 'migration-'))
  let database
  try {
    const names = (await readdir(source)).filter(name => /^(?:CURRENT|MANIFEST-\d+|\d+\.(?:log|ldb|sst))$/.test(name))
    for (const name of names) {
      const file = path.join(source, name), before = await lstat(file)
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('旧配置文件类型异常')
      await copyFile(file, path.join(snapshot, name))
      const after = await stat(file)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('旧配置仍在变化，请退出旧版后重试')
    }
    database = new ClassicLevel(snapshot, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' })
    const values = {}
    // Enumerate keys only; never decode or export values belonging to login/user data.
    for await (const raw of database.keys()) {
      const key = Buffer.from(raw), separator = key.indexOf(0)
      if (separator < 0 || !/^_(?:app|file):\/\//.test(key.subarray(0, separator).toString('utf8'))) continue
      const name = chromiumString(key.subarray(separator + 1))
      if (keys.has(name)) values[name] = chromiumString(await database.get(raw))
    }
    if (!values.setting) throw new Error('旧数据库中没有可识别的下载设置')
    return mapLegacySettings(values)
  }
  finally {
    if (database) await database.close()
    const absolute = path.resolve(snapshot)
    if (path.dirname(absolute) !== path.resolve(dataDirectory) || !path.basename(absolute).startsWith('migration-')) throw new Error('迁移快照路径异常')
    await rm(absolute, { recursive: true, force: true, maxRetries: 3 })
  }
}

export function parseLegacyHistory(content) {
  let parsed
  try { parsed = JSON.parse(String(content).split('').map(char => String.fromCharCode(char.charCodeAt(0) ^ 54)).join('')) }
  catch { throw new Error('无法读取 Bilidown 历史导出文件') }
  if (!Array.isArray(parsed.downloaded) || parsed.downloaded.length > 100000) throw new Error('历史文件格式不正确或记录过多')
  const records = [], invalid = []
  for (const row of parsed.downloaded) {
    if (!row || !/^BV[0-9A-Za-z]{10}$/.test(row.bv) || typeof row.title !== 'string' || typeof row.path !== 'string' || !path.isAbsolute(row.path)) { invalid.push('无效视频或目录'); continue }
    const legacyId = String(row.vid || row.bv + ':' + row.title + ':' + row.path).slice(0, 500)
    records.push({
      id: 'legacy-' + createHash('sha256').update(legacyId).digest('hex').slice(0, 32), legacySourceId: legacyId,
      bvid: row.bv, cid: 0, title: row.title.slice(0, 500), part: row.title.slice(0, 500), page: 1,
      author: String(row.upname || '').slice(0, 200), uid: Number(row.uid) || 0,
      directory: row.path, legacyPath: row.path, legacyType: String(row.type || '').slice(0, 500),
      status: 'completed', progress: 100, speed: 0, error: '', options: validateOptions({}),
      createdAt: new Date().toISOString(), completedAt: String(row.downDate || '').slice(0, 100),
      warnings: ['旧版记录仅保存目录，无法从记录中核对单个文件；不会自动重新下载'],
    })
  }
  return { records, invalid: invalid.length }
}

export class LegacyMigration {
  constructor({ store, dataDirectory }) {
    this.store = store; this.dataDirectory = dataDirectory
    store.db.exec('CREATE TABLE IF NOT EXISTS migration_previews(id TEXT PRIMARY KEY,data TEXT NOT NULL)')
  }
  async preview(params) {
    let settings
    const warnings = ['不迁移登录信息。自动关机与剪贴板监听保持关闭，可在新设置中主动启用。', '旧版窗口的关闭方式不迁移；新助手继续使用已选择的后台与托盘设置。']
    let records = [], invalid = 0
    const profile = path.resolve(params.profile || path.join(process.env.APPDATA || '', 'bilidown'))
    if (params.settings !== false) settings = await readLegacySettings(profile, this.dataDirectory)
    if (params.historyFile) {
      if (typeof params.historyFile !== 'string' || !path.isAbsolute(params.historyFile) || path.extname(params.historyFile).toLowerCase() !== '.bilidownexport') throw new Error('请选择原版导出的 .bilidownexport 文件')
      if ((await stat(params.historyFile)).size > 50 * 1024 * 1024) throw new Error('历史文件超过 50 MB')
      ;({ records, invalid } = parseLegacyHistory(await readFile(params.historyFile, 'utf8')))
    }
    const duplicate = records.filter(record => this.store.get(record.id) || this.store.get(record.legacySourceId)).length
    const missingDirectories = records.filter(record => !existsSync(record.directory)).length
    if (missingDirectories) warnings.push(String(missingDirectories) + ' 条记录的保存目录已不存在')
    const id = randomUUID(), preview = { id, settings, records, createdAt: Date.now() }
    this.store.db.prepare('INSERT INTO migration_previews VALUES(?,?)').run(id, JSON.stringify(preview))
    this.store.db.exec('DELETE FROM migration_previews WHERE rowid NOT IN (SELECT rowid FROM migration_previews ORDER BY rowid DESC LIMIT 3)')
    const current = this.store.settings()
    return { id, profile, changes: settings ? Object.entries(settings).map(([key, value]) => ({ key, before: current[key], after: value })) : [], total: records.length, duplicate, invalid, missingDirectories, warnings, sample: records.slice(0, 10).map(record => ({ title: record.title, bvid: record.bvid, directory: record.directory })) }
  }
  import(params) {
    const row = this.store.db.prepare('SELECT data FROM migration_previews WHERE id=?').get(String(params.id))
    if (!row) throw new Error('迁移预览不存在，请重新读取')
    const preview = JSON.parse(row.data)
    if (Date.now() - preview.createdAt > 30 * 60000) throw new Error('迁移预览已过期，请重新读取')
    const selected = params.keys || []
    if (!Array.isArray(selected) || selected.some(key => !Object.hasOwn(preview.settings || {}, key))) throw new Error('无效配置选择')
    let imported = 0, duplicate = 0
    this.store.db.exec('BEGIN IMMEDIATE')
    try {
      if (selected.length) this.store.settings(Object.fromEntries(selected.map(key => [key, preview.settings[key]])))
      if (params.history === true) for (const record of preview.records) {
        if (this.store.get(record.id) || this.store.get(record.legacySourceId)) duplicate++
        else { this.store.put(record); imported++ }
      }
      this.store.db.prepare('DELETE FROM migration_previews WHERE id=?').run(preview.id)
      this.store.db.exec('COMMIT')
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error }
    return { imported, duplicate, settings: selected.length }
  }
}
