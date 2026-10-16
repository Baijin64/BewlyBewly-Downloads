import browser from 'webextension-polyfill'

import type { LoadingMethod } from './broker'
import { abortError } from './broker'

export function loadingRequest<T = any>(method: LoadingMethod, params: object, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(abortError())
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    let finished = false
    let timer: ReturnType<typeof setTimeout>
    function finish(callback: () => void) {
      if (finished)
        return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      callback()
    }
    function cancel() {
      browser.runtime.sendMessage({ bewlyResource: true, method: 'cancel', id }).catch(() => {})
      finish(() => reject(abortError()))
    }
    timer = setTimeout(() => {
      browser.runtime.sendMessage({ bewlyResource: true, method: 'cancel', id }).catch(() => {})
      finish(() => reject(new Error('请求超时，请重试')))
    }, 25000)
    signal.addEventListener('abort', cancel, { once: true })
    browser.runtime.sendMessage({ bewlyResource: true, method, params, id }).then((reply) => {
      if (reply?.ok)
        finish(() => resolve(reply.result))
      else finish(() => reject(reply?.aborted ? abortError() : new Error('请求未成功，请重试')))
    }, () => finish(() => reject(new Error('请求未成功，请重试'))))
  })
}
