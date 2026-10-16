import browser from 'webextension-polyfill'

import type { DownloadMethod, DownloadReply } from './types'

export async function downloadRequest<T>(method: DownloadMethod, params: Record<string, unknown> = {}): Promise<T> {
  const timeoutMs = method === 'createTasks' ? 180000 : method === 'inspect' ? 30000 : 25000
  let timer: ReturnType<typeof setTimeout> | undefined
  let reply: DownloadReply<T>
  try {
    reply = await Promise.race([
      browser.runtime.sendMessage({ bewlyDownload: true, method, params }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('下载请求未响应，请重新加载扩展后重试。')), timeoutMs)
      }),
    ])
  }
  finally { clearTimeout(timer) }
  if (!reply?.ok)
    throw new Error(reply && !reply.ok ? reply.error : '下载助手没有响应')
  return reply.result
}
