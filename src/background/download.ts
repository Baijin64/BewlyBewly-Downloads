import browser from 'webextension-polyfill'

import { helperInstallHint, helperStartHint, helperUpdateHint } from '../download/platform'
import type { DownloadMethod, DownloadOptions, DownloadReply, DownloadTask, HelperStatus } from '../download/types'
import { cachedHealth, cachedPreview, cachedTasks, cachedWorkInProgress, downloadSnapshot, helperConnected, markHelperOffline, rememberReply } from './downloadCache'
import { biliApi, inspectDownload, inspectFormats, inspectQualities, inspectSubtitles, resolveDownload } from './downloadResolver'
import { requestNativeDownload, requestNativeDownloadDetached } from './nativeDownloadClient'

const methods = new Set<DownloadMethod>(['authorizeStart', 'health', 'inspect', 'inspectSubtitles', 'inspectQualities', 'inspectFormats', 'createTasks', 'stageTasks', 'listTasks', 'queryTasks', 'taskAction', 'batchAction', 'configure', 'previewPath', 'taskFile', 'tool', 'migrationPreview', 'migrationImport'])
const idempotentMethods = new Set<string>(['health', 'capabilities', 'queryTasks', 'getTask', 'getSettings', 'listTools', 'listTasks', 'inspect', 'inspectSubtitles', 'inspectQualities', 'inspectFormats', 'previewPath', 'migrationPreview', 'configure'])
const cookieNames = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4'])
const consentKey = 'bewly-native-autostart'
let initializing: Promise<void> | undefined
let lastInteractiveAt = 0
function initializeCache() {
  initializing ||= (async () => {
    const state = await downloadSnapshot()
    if (state.initialized && !state.counts.active && !await cachedWorkInProgress())
      return
    try {
      await rememberReply('uiSnapshot', await requestNativeDownload({ method: 'uiSnapshot' }))
      if ((await downloadSnapshot()).counts.active || await cachedWorkInProgress()) {
        // After a worker restart, attach to an existing download without waking one.
        await rememberReply('health', await requestNativeDownload({ method: 'health', allowStart: false }))
      }
    }
    catch { await rememberReply('uiSnapshot', { ok: false, error: '配置尚未同步' }) }
  })()
  return initializing
}
const startRequired = (): DownloadReply<never> => ({ ok: false, code: 'HELPER_START_REQUIRED', error: '需要启动本地下载助手' })
// While the last known state shows running work, a poll still asks the helper
// (without waking it) instead of serving the cache forever. An offline answer
// carries the helper's last snapshot, so finished tasks still show up. A helper
// that stopped mid-download leaves that snapshot unchanged, so after a few
// offline answers in a row the list waits for the user to reconnect.
const OFFLINE_PROBE_LIMIT = 3
let lastOfflineProbe = 0
let offlineProbeDelay = 5000
let offlineProbes = 0
async function shouldProbeHelper() {
  if (offlineProbes >= OFFLINE_PROBE_LIMIT || Date.now() - lastOfflineProbe < offlineProbeDelay || !await cachedWorkInProgress())
    return false
  lastOfflineProbe = Date.now()
  return true
}
function recordProbe(online: boolean) {
  offlineProbes = online ? 0 : offlineProbes + 1
  offlineProbeDelay = online ? 5000 : 30000
}
async function nativeRequest(method: DownloadMethod | 'expandLink', params: Record<string, unknown>, allowStart: boolean, session?: string): Promise<DownloadReply<any>> {
  if (allowStart) {
    const boot = await requestNativeDownload({ method: 'bootstrapStatus' }) as DownloadReply<{ connectorVersion: string, runtime: { ready: boolean, reason?: string } }>
    if (!boot.ok)
      return boot
    const [major, minor, patch] = boot.result.connectorVersion.split('.').map(Number)
    if (!Number.isFinite(patch) || (major === 0 && (minor < 2 || (minor === 2 && patch < 8))))
      return { ok: false, error: helperUpdateHint() }
    if (!boot.result.runtime.ready)
      return { ok: false, error: boot.result.runtime.reason || helperStartHint() }
  }
  const message = { method, params, allowStart, ...(session === undefined ? {} : { session }) }
  let reply = await requestNativeDownload(message)
  if (!reply.ok && ['SERVICE_OFFLINE', 'SERVICE_STOPPING'].includes(reply.code || '') && allowStart && idempotentMethods.has(method))
    reply = await requestNativeDownload(message)
  const prevState = await downloadSnapshot()
  const prevCounts = { ...prevState.counts }
  const hadWork = await cachedWorkInProgress()
  await rememberReply(method, reply, params)
  if (!reply.ok && ['SERVICE_OFFLINE', 'SERVICE_STOPPING'].includes(reply.code || ''))
    return startRequired()
  if (reply.ok && method === 'queryTasks' && params.tab && params.tab !== 'all') {
    const nextCounts = (reply.result as any)?.counts || prevCounts
    const countsChanged = prevCounts.active !== nextCounts.active || prevCounts.completed !== nextCounts.completed || prevCounts.failed !== nextCounts.failed
    if (countsChanged || hadWork !== await cachedWorkInProgress()) {
      try {
        const allParams = { tab: 'all', pageSize: 100 }
        const allReply = await requestNativeDownload({ method: 'queryTasks', params: allParams, allowStart: false })
        await rememberReply('queryTasks', allReply, allParams)
        if (!allReply.ok && !(allReply as any).snapshot)
          await rememberReply('uiSnapshot', await requestNativeDownload({ method: 'uiSnapshot' }))
      }
      catch { markHelperOffline() }
    }
  }
  if (reply.ok && !['health', 'queryTasks', 'listTasks'].includes(method) && !(method === 'tool' && params.op === 'status')) {
    // Capture the authoritative settings and latest records before an idle exit.
    for (const [nextMethod, nextParams] of [['health', {}], ['queryTasks', { tab: 'all', pageSize: 100 }]] as const) {
      try {
        await rememberReply(nextMethod, await requestNativeDownload({ method: nextMethod, params: nextParams, allowStart: false }), nextParams)
      }
      catch { markHelperOffline() }
    }
  }
  return reply
}

export function setupDownloadMessages() {
  void initializeCache().catch(() => {})
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.bewlyDownload !== true)
      return undefined
    return handle(message, sender)
  })
}

async function handle(message: { method: DownloadMethod, params: Record<string, unknown> }, sender: browser.Runtime.MessageSender): Promise<DownloadReply<unknown>> {
  try {
    const url = new URL(sender.url || '')
    if (sender.id !== browser.runtime.id || url.protocol !== 'https:' || !(url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')))
      throw new Error('下载请求来源无效')
    if (!methods.has(message.method) || JSON.stringify(message.params).length > 512 * 1024)
      throw new Error('下载请求无效')
    let params = message.params
    await initializeCache()
    if (message.method === 'authorizeStart') {
      await browser.storage.local.set({ [consentKey]: 'true' })
      return { ok: true, result: { allowed: true } }
    }
    if (message.method === 'previewPath')
      return { ok: true, result: await cachedPreview(params) }
    if (['health', 'queryTasks', 'listTasks'].includes(message.method)) {
      const hadWork = await cachedWorkInProgress()
      if (helperConnected() || params.connect === true || await shouldProbeHelper()) {
        if (params.connect === true)
          recordProbe(true)
        try {
          const reply = await nativeRequest(message.method, params, false)
          recordProbe(reply.ok)
          if (reply.ok)
            return message.method === 'health' ? { ...reply, result: { ...(reply.result as HelperStatus), runtime: reply.runtime, deferred: false } } : reply
        }
        catch {
          markHelperOffline()
          recordProbe(false)
        }
        if (params.connect === true || (hadWork && await cachedWorkInProgress())) {
          try {
            await rememberReply('uiSnapshot', await requestNativeDownload({ method: 'uiSnapshot' }))
          }
          catch { /* Show the last browser snapshot if the connector is missing. */ }
        }
      }
      if (message.method === 'health')
        return { ok: true, result: await cachedHealth() }
      const tasks = await cachedTasks(params)
      return { ok: true, result: message.method === 'listTasks' ? tasks.items : tasks }
    }
    if (message.method === 'tool' && params.op === 'joinTime') {
      const data = await biliApi('https://member.bilibili.com/x2/creative/h5/calendar/event', { ts: '0' })
      const joined = data.pfs?.profile?.jointime
      if (!joined)
        throw new Error('官方接口当前未提供入站时间，请确认当前浏览器已登录 B 站')
      return { ok: true, result: { id: 'browser-join-time', status: 'completed', result: { text: new Date(Number(joined) * 1000).toLocaleString('zh-CN') } } }
    }
    if (message.method === 'inspect') {
      if (typeof params.video === 'string' && /^https?:\/\/(?:b23\.tv|bili2233\.(?:cn|com))\//.test(params.video)) {
        const value = (await browser.storage.local.get(consentKey))[consentKey]
        const allowed = value === 'true' || value === true
        if (!helperConnected() && !allowed)
          return startRequired()
        const expanded = await nativeRequest('expandLink', { video: params.video }, allowed)
        if (!expanded.ok)
          return expanded
        return { ok: true, result: await inspectDownload(expanded.result) }
      }
      return { ok: true, result: await inspectDownload(params.video) }
    }
    if (message.method === 'inspectSubtitles')
      return { ok: true, result: await inspectSubtitles(params.video, params.cid) }
    if (message.method === 'inspectQualities')
      return { ok: true, result: await inspectQualities(params.video, params.cid) }
    if (message.method === 'inspectFormats')
      return { ok: true, result: await inspectFormats(params.video, params.cid) }
    if (message.method === 'tool' && ['status', 'cancel'].includes(String(params.op))) {
      if (!helperConnected())
        return params.op === 'cancel' ? { ok: true, result: { cancelled: true } } : { ok: false, error: '本地助手已退出，请重新连接后检查工具任务。' }
      const reply = await nativeRequest('tool', params, false)
      return !reply.ok && reply.code === 'HELPER_START_REQUIRED' ? { ok: false, error: '本地助手已退出，请重新连接后检查工具任务。' } : reply
    }
    const allowedValue = (await browser.storage.local.get(consentKey))[consentKey]
    const allowStart = allowedValue === 'true' || allowedValue === true
    if (!helperConnected() && !allowStart && Date.now() - lastInteractiveAt > 5000)
      return startRequired()
    if (message.method === 'tool' && params.op === 'pick') {
      // The picker stays open until the user chooses, so it cannot share the 15-second queue.
      const reply = await requestNativeDownloadDetached({ method: 'tool', params, allowStart }, 10 * 60_000)
      await rememberReply('tool', reply, params)
      if (reply.ok)
        lastInteractiveAt = Date.now()
      return !reply.ok && ['SERVICE_OFFLINE', 'SERVICE_STOPPING'].includes(reply.code || '') ? startRequired() : reply
    }
    if (message.method === 'createTasks' || message.method === 'stageTasks') {
      const info = await inspectDownload(params.video)
      const cids = params.cids as number[]
      if (!Array.isArray(cids) || !cids.length || cids.length > 10000 || cids.some(cid => !info.pages.some(p => p.cid === cid)))
        throw new Error('无效分 P 选择')
      const prepared: Record<string, unknown> = {}
      // Resolve only an immediate single task here. The durable native queue resolves
      // batch tasks as they start, so a large collection cannot expire in the browser.
      if (message.method === 'createTasks' && cids.length === 1 && (params.options as DownloadOptions)?.outputs?.some(kind => ['video', 'silent', 'audio', 'mp3'].includes(kind)))
        prepared[cids[0]] = await resolveDownload(info.bvid, cids[0], params.options as DownloadOptions)
      params = { ...params, info: { ...info, ...(params.group ? { group: params.group } : {}) }, prepared }
    }
    if (message.method === 'taskAction' && ['resume', 'retry'].includes(String(params.action))) {
      const snapshot = await downloadSnapshot()
      const reply = snapshot.tasks.some(task => task.id === params.id)
        ? { ok: true as const, result: snapshot.tasks }
        : await nativeRequest('listTasks', {}, allowStart) as DownloadReply<(DownloadTask & { options: DownloadOptions })[]>
      if (!reply.ok)
        throw new Error(reply.error)
      const task = reply.result.find(task => task.id === params.id)
      if (!task)
        throw new Error('任务不存在')
      params = { ...params, prepared: await resolveDownload(task.bvid, task.cid, task.options) }
    }
    let session: string | undefined
    if (['createTasks', 'stageTasks', 'batchAction'].includes(message.method) || (message.method === 'taskAction' && ['start', 'resume', 'retry'].includes(String(params.action)))) {
      // Only the Bilibili session needed for the user-initiated download leaves the browser.
      const cookieQuery: browser.Cookies.GetAllDetailsType = { domain: 'bilibili.com' }
      if (sender?.tab?.cookieStoreId)
        cookieQuery.storeId = sender.tab.cookieStoreId
      const cookies = await browser.cookies.getAll(cookieQuery)
      const seen = new Map<string, browser.Cookies.Cookie>()
      for (const cookie of cookies.filter(cookie => cookieNames.has(cookie.name))) {
        const existing = seen.get(cookie.name)
        if (!existing) {
          seen.set(cookie.name, cookie)
        }
        else {
          const existingScore = (existing.domain?.length || 0) + (existing.path?.length || 0)
          const currentScore = (cookie.domain?.length || 0) + (cookie.path?.length || 0)
          if (currentScore > existingScore)
            seen.set(cookie.name, cookie)
        }
      }
      session = Array.from(seen.values()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    }
    return await nativeRequest(message.method, params, allowStart, session)
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const missing = /specified native|native.*not found|native.*forbidden/i.test(detail)
    return { ok: false, error: missing ? helperInstallHint() : detail }
  }
}
