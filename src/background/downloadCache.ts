import browser from 'webextension-polyfill'

import { planLocation, validateTemplate } from '../download/naming'
import type { DownloadReply, DownloadTask, HelperRuntime, HelperSettings, HelperStatus, TaskQuery } from '../download/types'
import { defaultOptions } from '../download/types'
import { uiTask } from '../download/uiTask'

interface Snapshot { health?: HelperStatus, tasks: DownloadTask[], counts: TaskQuery['counts'], syncedAt?: string, initialized?: boolean }
const key = 'bewly-download-snapshot'
let snapshot: Snapshot
let ready: Promise<void> | undefined
let saving = Promise.resolve()
let connected = false
export async function downloadSnapshot() {
  ready ||= browser.storage.local.get(key).then((data) => {
    const saved = data[key]
    snapshot = { tasks: [], counts: { pending: 0, active: 0, completed: 0, failed: 0 }, ...saved }
  })
  await ready
  return snapshot
}
export function helperConnected() {
  return connected
}
function save() {
  const value = structuredClone(snapshot)
  saving = saving.catch(() => {}).then(() => browser.storage.local.set({ [key]: value })).catch(() => {})
  return saving
}
export async function rememberReply(method: string, reply: DownloadReply<any>, params: Record<string, unknown> = {}) {
  await downloadSnapshot()
  if (reply.ok) {
    if (reply.runtime)
      connected = reply.runtime.mode === 'manual' || reply.runtime.state === 'busy'
    if (method === 'health')
      snapshot.health = { ...reply.result, runtime: reply.runtime }
    if (method === 'uiSnapshot') {
      snapshot.health = reply.result.health
      snapshot.tasks = reply.result.items || []
      snapshot.counts = reply.result.counts || snapshot.counts
      snapshot.syncedAt = reply.result.syncedAt
    }
    if (method === 'configure' && snapshot.health)
      snapshot.health.settings = reply.result
    let tasks: DownloadTask[] = []
    if (method === 'queryTasks') {
      tasks = reply.result.items
      snapshot.counts = reply.result.counts
      snapshot.syncedAt = new Date().toISOString()
      if ((!params.tab || params.tab === 'all') && !params.search && (!params.page || params.page === 1) && reply.result.total <= tasks.length)
        snapshot.tasks = []
    }
    else if (['createTasks', 'stageTasks', 'listTasks'].includes(method)) {
      tasks = reply.result
    }
    else if (method === 'taskAction' && reply.result?.id) {
      tasks = [reply.result]
    }
    else if (method === 'batchAction') {
      tasks = reply.result.results || []
    }
    const known = new Map(snapshot.tasks.map(task => [task.id, task]))
    if (method === 'batchAction' && params.action === 'remove' && params.all && !reply.result.errorCount && !reply.result.errors?.length) {
      const groups: Record<string, string[]> = { pending: ['pending'], active: ['queued', 'resolving', 'downloading', 'paused'], completed: ['completed'], failed: ['failed', 'cancelled'] }
      for (const [id, task] of known) {
        if (groups[String(params.all)]?.includes(task.status))
          known.delete(id)
      }
    }
    for (const task of tasks || []) known.set(task.id, uiTask(task))
    const removed = [reply.result?.removed, ...(reply.result?.results || []).map((row: any) => row.removed)].filter(Boolean)
    for (const id of removed) known.delete(id)
    snapshot.tasks = [...known.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 500)
  }
  else if (['SERVICE_OFFLINE', 'SERVICE_STOPPING'].includes(reply.code || '')) {
    connected = false
  }
  snapshot.initialized = true
  await save()
}
export function markHelperOffline() {
  connected = false
}
export async function cachedHealth(): Promise<HelperStatus> {
  const state = await downloadSnapshot()
  const settings: HelperSettings = { directory: '', maxConcurrent: 4, defaultOptions, features: { cover: true, audio: true, xml: false, ass: false, nfo: false, srt: false, tools: false }, soundTip: true, shutdown: false, listenClipboard: false, idleExitMinutes: 0, tray: true }
  const runtime: HelperRuntime = { running: false, mode: 'on-demand', state: 'stopped' }
  return { version: '未连接', protocol: 2, capabilities: ['audio-highest'], engineInstalled: false, settings, ...state.health, deferred: !connected, runtime: connected ? state.health?.runtime : runtime }
}
export async function cachedTasks(params: Record<string, unknown>): Promise<TaskQuery> {
  const state = await downloadSnapshot()
  const statuses: Record<string, string[]> = { pending: ['pending'], active: ['queued', 'resolving', 'downloading', 'paused', 'muxing', 'postprocessing'], completed: ['completed'], failed: ['failed', 'cancelled'] }
  const search = String(params.search || '').toLowerCase()
  const rows = state.tasks.filter(task => (!statuses[String(params.tab)] || statuses[String(params.tab)].includes(task.status)) && (!search || [task.title, task.part, task.bvid].some(value => value?.toLowerCase().includes(search))))
  const page = Math.max(1, Number(params.page) || 1)
  const pageSize = Math.max(1, Math.min(100, Number(params.pageSize) || 50))
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, counts: state.counts, offline: true, syncedAt: state.syncedAt }
}
export async function cachedPreview(params: Record<string, any>) {
  const state = await cachedHealth()
  const task = { ...params.task, options: params.options, createdAt: params.task?.createdAt || new Date().toISOString() }
  validateTemplate(task.options.filenameTemplate)
  validateTemplate(task.options.folderTemplate || '')
  const { parts, basename } = planLocation(task)
  const root = String(params.directory ?? state.settings.directory) || '保存目录将在助手启动后读取'
  const directory = parts.length ? [root.replace(/[\\/]+$/, ''), ...parts].join('\\') : root
  if ((`${directory}\\${basename}`).length > 235)
    throw new Error('输出路径过长，请缩短命名规则或保存目录')
  return { directory, basename }
}
