import { ref } from 'vue'

import { useStorageLocal } from '~/composables/useStorageLocal'

import { defaultOptions, normalizeDownloadOptions } from './types'

export const downloadPreferences = useStorageLocal('bewly-download-preferences', { ...defaultOptions }, { mergeDefaults: value => normalizeDownloadOptions(value) })
export const downloadTarget = ref<{ video: string, cid?: number, videos?: string[], allParts?: boolean, instanceId: number }>()
let dialogSequence = 0
export const showDownloadTasks = ref(false)
export const downloadTaskCount = ref(0)

export function openDownloader() {
  const url = new URL('https://www.bilibili.com/')
  url.searchParams.set('page', 'Downloads')
  if (location.hostname === 'www.bilibili.com' && location.pathname === '/') {
    history.pushState({}, '', url)
    window.dispatchEvent(new Event('bewly-open-downloads'))
  }
  else {
    window.open(url, '_blank', 'noopener')
  }
}

export function openVideoDownload(video: string, cid?: number) {
  downloadTarget.value = { video, cid, instanceId: ++dialogSequence }
}

export function openDownloadSelection(videos: string[], allParts = false) {
  if (videos.length)
    downloadTarget.value = { video: videos[0], videos: [...videos], allParts, instanceId: ++dialogSequence }
}
