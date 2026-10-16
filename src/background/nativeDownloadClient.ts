import browser from 'webextension-polyfill'

import type { DownloadReply } from '../download/types'

let port: browser.Runtime.Port | undefined
let active: { id: number, resolve: (reply: DownloadReply<unknown>) => void, reject: (error: Error) => void, timeout: ReturnType<typeof setTimeout> } | undefined
let sequence = 0
let queued = 0
let chain: Promise<unknown> = Promise.resolve()
let idleTimer: ReturnType<typeof setTimeout> | undefined

function disconnect() {
  clearTimeout(idleTimer)
  const previous = port
  port = undefined
  previous?.disconnect()
}

function ensurePort() {
  if (port)
    return port
  const connection = browser.runtime.connectNative('io.bewly.download')
  port = connection
  connection.onMessage.addListener((reply) => {
    if (connection !== port || !active || reply.requestId !== active.id)
      return
    const pending = active
    active = undefined
    clearTimeout(pending.timeout)
    pending.resolve(reply)
    idleTimer = setTimeout(disconnect, 15000)
  })
  connection.onDisconnect.addListener(() => {
    if (connection !== port)
      return
    port = undefined
    clearTimeout(idleTimer)
    const detail = browser.runtime.lastError?.message || '下载助手连接中断'
    if (active) {
      clearTimeout(active.timeout)
      active.reject(new Error(/not found|not registered|specified native/i.test(detail)
        ? '未找到下载助手，请安装新版助手并从开始菜单打开一次完成连接。'
        : `下载助手连接中断：${detail}`))
      active = undefined
    }
  })
  return connection
}

export function requestNativeDownload(message: Record<string, unknown>): Promise<DownloadReply<unknown>> {
  if (queued >= 20)
    return Promise.reject(new Error('下载请求过多，请稍后重试'))
  queued++
  const request = chain.catch(() => {}).then(() => new Promise<DownloadReply<unknown>>((resolve, reject) => {
    clearTimeout(idleTimer)
    const id = ++sequence
    const timeout = setTimeout(() => {
      if (active?.id !== id)
        return
      active = undefined
      disconnect()
      reject(new Error('下载助手通信超时，连接已关闭以防止进程累积。请更新到 0.1.2 或更高版本后重试。'))
    }, 15000)
    active = { id, resolve, reject, timeout }
    try {
      ensurePort().postMessage({ ...message, requestId: id })
    }
    catch (error) {
      clearTimeout(timeout)
      active = undefined
      disconnect()
      reject(error)
    }
  })).finally(() => { queued-- })
  chain = request
  return request
}
