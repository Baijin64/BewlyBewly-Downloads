import browser from 'webextension-polyfill'

import type { DownloadMethod, DownloadOptions, DownloadReply, DownloadTask } from '../download/types'
import { biliApi, inspectDownload, inspectFormats, inspectQualities, inspectSubtitles, resolveDownload } from './downloadResolver'
import { requestNativeDownload } from './nativeDownloadClient'

const methods = new Set<DownloadMethod>(['health', 'inspect', 'inspectSubtitles', 'inspectQualities', 'inspectFormats', 'createTasks', 'stageTasks', 'listTasks', 'queryTasks', 'taskAction', 'batchAction', 'configure', 'previewPath', 'taskFile', 'tool', 'migrationPreview', 'migrationImport'])
const cookieNames = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4'])

export function setupDownloadMessages() {
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
    if (message.method === 'tool' && params.op === 'joinTime') {
      const data = await biliApi('https://member.bilibili.com/x2/creative/h5/calendar/event', { ts: '0' })
      const joined = data.pfs?.profile?.jointime
      if (!joined)
        throw new Error('官方接口当前未提供入站时间，请确认当前浏览器已登录 B 站')
      return { ok: true, result: { id: 'browser-join-time', status: 'completed', result: { text: new Date(Number(joined) * 1000).toLocaleString('zh-CN') } } }
    }
    if (message.method === 'inspect')
      return { ok: true, result: await inspectDownload(params.video) }
    if (message.method === 'inspectSubtitles')
      return { ok: true, result: await inspectSubtitles(params.video, params.cid) }
    if (message.method === 'inspectQualities')
      return { ok: true, result: await inspectQualities(params.video, params.cid) }
    if (message.method === 'inspectFormats')
      return { ok: true, result: await inspectFormats(params.video, params.cid) }
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
      const reply = await requestNativeDownload({ method: 'listTasks' }) as DownloadReply<(DownloadTask & { options: DownloadOptions })[]>
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
    return await requestNativeDownload({ method: message.method, params, ...(session === undefined ? {} : { session }) })
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const missing = /specified native|native.*not found|native.*forbidden/i.test(detail)
    return { ok: false, error: missing ? '请先安装 Bewly 下载助手，并从开始菜单打开一次完成浏览器连接。然后点击重试。' : detail }
  }
}
