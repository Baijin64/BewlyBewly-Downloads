import browser from 'webextension-polyfill'

import type { DownloadMethod, DownloadOptions, DownloadReply, DownloadTask, HelperStatus } from '../download/types'
import { cachedHealth, cachedPreview, cachedTasks, downloadSnapshot, helperConnected, markHelperOffline, rememberReply } from './downloadCache'
import { biliApi, inspectDownload, inspectFormats, inspectQualities, inspectSubtitles, resolveDownload } from './downloadResolver'
import { requestNativeDownload } from './nativeDownloadClient'

const methods = new Set<DownloadMethod>(['authorizeStart', 'health', 'inspect', 'inspectSubtitles', 'inspectQualities', 'inspectFormats', 'createTasks', 'stageTasks', 'listTasks', 'queryTasks', 'taskAction', 'batchAction', 'configure', 'previewPath', 'taskFile', 'tool', 'migrationPreview', 'migrationImport'])
const cookieNames = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4'])
const consentKey = 'bewly-native-autostart'
let initializing: Promise<void> | undefined
function initializeCache() {
  initializing ||= (async () => {
    const state = await downloadSnapshot()
    if (state.initialized && !state.counts.active)
      return
    try {
      await rememberReply('uiSnapshot', await requestNativeDownload({ method: 'uiSnapshot' }))
      if ((await downloadSnapshot()).counts.active) {
        // After a worker restart, attach to an existing download without waking one.
        await rememberReply('health', await requestNativeDownload({ method: 'health', allowStart: false }))
      }
    }
    catch { await rememberReply('uiSnapshot', { ok: false, error: '配置尚未同步' }) }
  })()
  return initializing
}
const startRequired = (): DownloadReply<never> => ({ ok: false, code: 'HELPER_START_REQUIRED', error: '需要启动本地下载助手' })
async function nativeRequest(method: DownloadMethod | 'expandLink', params: Record<string, unknown>, allowStart: boolean, session?: string): Promise<DownloadReply<any>> {
  if (allowStart) {
    const boot = await requestNativeDownload({ method: 'bootstrapStatus' }) as DownloadReply<{ connectorVersion: string, runtime: { ready: boolean, reason?: string } }>
    if (!boot.ok)
      return boot
    const [major, minor, patch] = boot.result.connectorVersion.split('.').map(Number)
    if (!Number.isFinite(patch) || (major === 0 && (minor < 2 || (minor === 2 && patch < 8))))
      return { ok: false, error: '按需启动需要下载助手 0.2.8 或更新版本，请更新 MSIX。' }
    if (!boot.result.runtime.ready)
      return { ok: false, error: boot.result.runtime.reason || '请从 Windows 开始菜单打开下载助手，安装 Node.js 后重试。' }
  }
  const message = { method, params, allowStart, ...(session === undefined ? {} : { session }) }
  let reply = await requestNativeDownload(message)
  if (!reply.ok && reply.code === 'SERVICE_OFFLINE' && allowStart)
    reply = await requestNativeDownload(message)
  await rememberReply(method, reply, params)
  if (!reply.ok && ['SERVICE_OFFLINE', 'SERVICE_STOPPING'].includes(reply.code || ''))
    return startRequired()
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
      if (helperConnected() || params.connect === true) {
        try {
          const reply = await nativeRequest(message.method, params, false)
          if (reply.ok)
            return message.method === 'health' ? { ...reply, result: { ...(reply.result as HelperStatus), runtime: reply.runtime, deferred: false } } : reply
        }
        catch { markHelperOffline() }
        if (params.connect === true) {
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
    if (!helperConnected() && !allowStart)
      return startRequired()
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
      const cookies = await browser.cookies.getAll({ domain: 'bilibili.com' })
      session = cookies.filter(cookie => cookieNames.has(cookie.name)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    }
    return await nativeRequest(message.method, params, allowStart, session)
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const missing = /specified native|native.*not found|native.*forbidden/i.test(detail)
    return { ok: false, error: missing ? '请先安装 Bewly 下载助手，并从开始菜单打开一次完成浏览器连接。然后点击重试。' : detail }
  }
}
