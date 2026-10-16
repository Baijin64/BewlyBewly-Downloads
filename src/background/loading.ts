import browser from 'webextension-polyfill'

import type { LoadingMethod } from '~/loading/broker'
import { abortError, isAbortError, loadingMethods, previewExpiry, ResourceBroker } from '~/loading/broker'

import API_VIDEO from './messageListeners/api/video'

const broker = new ResourceBroker()
export function setupLoadingMessages() {
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.bewlyResource !== true)
      return undefined
    return handle(message, sender)
  })
  browser.tabs.onRemoved.addListener(tab => broker.clear(`${tab}:`))
  browser.cookies.onChanged.addListener(({ cookie }) => {
    if ((cookie.domain === 'bilibili.com' || cookie.domain.endsWith('.bilibili.com')) && ['SESSDATA', 'DedeUserID'].includes(cookie.name))
      broker.clear()
  })
}

async function handle(message: { id: string, method: LoadingMethod | 'cancel', params?: Record<string, any> }, sender: browser.Runtime.MessageSender) {
  try {
    const url = new URL(sender.url || '')
    if (sender.id !== browser.runtime.id || sender.tab?.id === undefined || url.protocol !== 'https:' || !(url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')))
      throw new Error('Invalid sender')
    if (typeof message.id !== 'string' || !/^[\w-]{1,80}$/.test(message.id))
      throw new Error('Invalid identifier')
    const documentId = (sender as browser.Runtime.MessageSender & { documentId?: string }).documentId
    const scope = `${sender.tab.id}:${sender.frameId ?? 0}:${documentId || sender.url}:`
    const consumer = scope + message.id
    if (message.method === 'cancel') {
      broker.cancel(consumer)
      return { ok: true }
    }
    if (!loadingMethods.includes(message.method) || !message.params || typeof message.params !== 'object' || JSON.stringify(message.params).length > 8192)
      throw new Error('Invalid request')
    const method = message.method
    const params = message.params
    const key = scope + method + JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))
    const preview = method === 'getVideoInfo' || method === 'getVideoPreview'
    const result = await broker.request(key, consumer, async (signal) => {
      const api = API_VIDEO[method]
      const target = new URL(api.url)
      for (const [name, value] of Object.entries({ ...api.params, ...params })) {
        if (value !== undefined && value !== null && value !== '')
          target.searchParams.set(name, String(value))
      }
      const headers: Record<string, string> = {}
      // Preserve Firefox container isolation, matching the existing API bridge.
      if (sender.tab?.cookieStoreId) {
        const cookies = await browser.cookies.getAll({ storeId: sender.tab.cookieStoreId })
        headers['firefox-multi-account-cookie'] = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, 20000)
      try {
        if (signal.aborted)
          controller.abort()
        const response = await fetch(target, { headers, credentials: 'include', signal: controller.signal })
        if (!response.ok)
          throw new Error('Request failed')
        return await response.json()
      }
      catch {
        if (signal.aborted)
          throw abortError()
        throw new Error('Loading request failed or timed out')
      }
      finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    }, { preview, ttl: (value) => {
      if (value?.code !== 0)
        return 0
      if (method === 'getVideoInfo')
        return 60000
      if (method === 'getVideoPreview')
        return Math.max(0, previewExpiry(value.data?.durl?.[0]?.url || '', Date.now()) - Date.now())
      return 0 // Recommendations must remain fresh; only in-flight calls are shared.
    } })
    return { ok: true, result }
  }
  catch (error) { return { ok: false, aborted: isAbortError(error) } }
}
