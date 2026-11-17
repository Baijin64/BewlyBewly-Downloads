import browser from 'webextension-polyfill'

import { helperInstallHint } from '../download/platform'
import type { DownloadReply } from '../download/types'
import { markHelperOffline, rememberReply } from './downloadCache'

let port: browser.Runtime.Port | undefined
let active: { id: number, method: unknown, resolve: (reply: DownloadReply<unknown>) => void, reject: (error: Error) => void, timeout: ReturnType<typeof setTimeout> } | undefined
let sequence = 0
let queued = 0
let chain: Promise<unknown> = Promise.resolve()
let idleTimer: ReturnType<typeof setTimeout> | undefined

export function disconnect(reason?: string) {
  clearTimeout(idleTimer)
  const previous = port
  port = undefined
  if (active) {
    const pending = active
    active = undefined
    clearTimeout(pending.timeout)
    pending.reject(new Error(reason || '下载助手连接已断开'))
  }
  previous?.disconnect()
}

function ensurePort() {
  if (port)
    return port
  const connection = browser.runtime.connectNative('io.bewly.download')
  port = connection
  connection.onMessage.addListener((reply) => {
    if (connection === port && reply.code === 'SERVICE_OFFLINE' && reply.snapshot)
      void rememberReply('uiSnapshot', { ok: true, result: reply.snapshot })
    if (connection === port && reply.event === 'serviceStopped') {
      markHelperOffline()
      if (reply.snapshot)
        void rememberReply('uiSnapshot', { ok: true, result: reply.snapshot })
      if (active) {
        clearTimeout(active.timeout)
        active.resolve({ ok: false, code: 'SERVICE_OFFLINE', error: '下载助手已空闲退出', ...(reply.snapshot ? { snapshot: reply.snapshot } : {}) } as DownloadReply<unknown>)
        active = undefined
      }
      disconnect()
      return
    }
    if (connection !== port || !active || reply.requestId !== active.id)
      return
    const pending = active
    active = undefined
    clearTimeout(pending.timeout)
    pending.resolve(reply)
    const idle = pending.method === 'uiSnapshot' || (!reply.ok && reply.code) || (reply.runtime?.mode === 'on-demand' && reply.runtime.state === 'idle')
    idleTimer = setTimeout(disconnect, idle ? 500 : 15000)
  })
  connection.onDisconnect.addListener(() => {
    if (connection !== port)
      return
    port = undefined
    markHelperOffline()
    clearTimeout(idleTimer)
    const detail = browser.runtime.lastError?.message || '下载助手连接中断'
    if (active) {
      clearTimeout(active.timeout)
      active.reject(new Error(/not found|not registered|specified native/i.test(detail)
        ? helperInstallHint()
        : `下载助手连接中断：${detail}`))
      active = undefined
    }
  })
  return connection
}

/**
 * Sends one request that waits on the user (the native picker) over its own
 * connection, so it is not cut off by the 15-second timeout and does not hold
 * up task polling on the shared queue.
 */
export function requestNativeDownloadDetached(message: Record<string, unknown>, timeoutMs: number): Promise<DownloadReply<unknown>> {
  return new Promise((resolve, reject) => {
    const connection = browser.runtime.connectNative('io.bewly.download')
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (settle: () => void) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      settle()
      try {
        connection.disconnect()
      }
      catch { /* Already closed by the host. */ }
    }
    timeout = setTimeout(() => finish(() => reject(new Error('等待本地选择窗口超时，请重试'))), timeoutMs)
    connection.onMessage.addListener((reply) => {
      if (reply.requestId === 1)
        finish(() => resolve(reply))
    })
    connection.onDisconnect.addListener(() => {
      const detail = browser.runtime.lastError?.message || '下载助手连接中断'
      finish(() => reject(new Error(/not found|not registered|specified native/i.test(detail) ? helperInstallHint() : `下载助手连接中断：${detail}`)))
    })
    connection.postMessage({ ...message, requestId: 1 })
  })
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
      const pending = active
      active = undefined
      markHelperOffline('Native Host 请求超时')
      disconnect('Native Host 请求超时')
      pending.reject(new Error('下载助手通信超时，连接已关闭以防止进程累积。请更新到 0.1.2 或更高版本后重试。'))
    }, 15000)
    active = { id, method: message.method, resolve, reject, timeout }
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
