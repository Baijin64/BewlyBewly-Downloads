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

const mutatingMethods = new Set([
  'createTasks',
  'stageTasks',
  'pauseTask',
  'resumeTask',
  'cancelTask',
  'deleteTask',
  'retryTask',
  'updateSettings',
  'taskAction',
  'batchAction',
  'configure',
  'migrationImport',
  'uiSnapshot',
])

let lastSavedFingerprint = ''
let lastSavedState = ''
let lastSaveTime = 0
let throttleTimer: ReturnType<typeof setTimeout> | undefined

function computeFingerprint(tasks: DownloadTask[] = snapshot?.tasks || []): string {
  let out = `${tasks.length}:`
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]
    const p = (t as any).progress
    out += `${t.id}|${t.status}|${p?.downloadedBytes ?? 0}|${p?.totalBytes ?? 0}|${p?.percent ?? p ?? 0}|${t.error ?? ''}|${(t as any).updatedAt ?? ''};`
  }
  return out
}

/**
 * Statuses and counts only. A change here is saved at once: a worker restart
 * reads these to decide whether to reattach, and a lost save would leave the
 * list frozen on an old state.
 */
function computeStateFingerprint(): string {
  if (!snapshot)
    return ''
  return JSON.stringify([snapshot.counts, snapshot.tasks.map(task => [task.id, task.status, task.error ?? ''])])
}

function saveNow() {
  if (throttleTimer) {
    clearTimeout(throttleTimer)
    throttleTimer = undefined
  }
  lastSavedFingerprint = computeFingerprint()
  lastSavedState = computeStateFingerprint()
  lastSaveTime = Date.now()
  const value: Snapshot = {
    health: snapshot.health,
    tasks: snapshot.tasks,
    counts: snapshot.counts,
    syncedAt: snapshot.syncedAt,
    initialized: snapshot.initialized,
  }
  saving = saving.catch(() => {}).then(() => browser.storage.local.set({ [key]: value })).catch(() => {})
  return saving
}

export async function downloadSnapshot() {
  ready ||= browser.storage.local.get(key).then((data) => {
    const saved = data[key]
    snapshot = { tasks: [], counts: { pending: 0, active: 0, completed: 0, failed: 0 }, ...saved }
    lastSavedFingerprint = computeFingerprint()
    lastSavedState = computeStateFingerprint()
  })
  await ready
  return snapshot
}
export function helperConnected() {
  return connected
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
  const isMutating = mutatingMethods.has(method)
  const currentFingerprint = computeFingerprint()
  const isDirty = currentFingerprint !== lastSavedFingerprint

  if (isMutating || computeStateFingerprint() !== lastSavedState) {
    await saveNow()
  }
  else if (isDirty) {
    const elapsed = Date.now() - lastSaveTime
    if (elapsed >= 15000) {
      await saveNow()
    }
    else if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = undefined
        if (computeFingerprint() !== lastSavedFingerprint)
          void saveNow()
      }, 15000 - elapsed)
    }
  }
}
export function markHelperOffline(_reason?: string) {
  connected = false
}
const runningStatuses = ['queued', 'resolving', 'downloading', 'muxing', 'postprocessing']
/** Whether the last known state still has work the helper is carrying out. */
export async function cachedWorkInProgress() {
  const state = await downloadSnapshot()
  return state.tasks.some(task => runningStatuses.includes(task.status))
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
