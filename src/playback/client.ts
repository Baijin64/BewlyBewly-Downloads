import browser from 'webextension-polyfill'

import type { PlaybackDiagnostic, PlaybackSample } from './engine'

export interface PlaybackReply { enabled: boolean, diagnostic?: PlaybackDiagnostic }
export async function playbackRequest(method: string, sample?: PlaybackSample, origins?: string[]): Promise<PlaybackReply> {
  const reply = await browser.runtime.sendMessage({ bewlyPlayback: true, method, sample, origins })
  if (!reply?.ok)
    throw new Error(reply?.error || '播放优化没有响应')
  return reply.result
}
