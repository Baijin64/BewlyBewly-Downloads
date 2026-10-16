<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'

import { settings } from '~/logic'

import { downloadRequest } from '../client'
import {
  downloadTarget,
  downloadTaskCount,
  openDownloader,
  openVideoDownload,
  showDownloadTasks,
} from '../state'
import type { TaskQuery } from '../types'
import { createVideoToolbarDownload } from '../videoToolbar'

const DownloadDialog = defineAsyncComponent(
  () => import('./DownloadDialog.vue'),
)
const href = ref(location.href)
const currentVideo = computed(
  () => /\/video\/(BV[0-9A-Za-z]{10})(?:\/|\?|$)/.exec(href.value)?.[1],
)
const topFrame = window === window.top
let timer: ReturnType<typeof setInterval> | undefined
let countTick = 0
let readingCount = false
const toolbar = createVideoToolbarDownload({
  onDownload: () => openVideoDownload(location.href),
  accentColor: () => settings.value.themeColor,
})
async function updateCount() {
  if (!topFrame || readingCount || document.hidden)
    return
  readingCount = true
  try {
    const query = await downloadRequest<TaskQuery>('queryTasks', {
      pageSize: 1,
    })
    downloadTaskCount.value = query.counts.pending + query.counts.active
  }
  catch {
    /* Opening the downloader presents connection errors. */
  }
  finally {
    readingCount = false
  }
}
watch(showDownloadTasks, (show) => {
  if (show) {
    showDownloadTasks.value = false
    openDownloader()
  }
})
onMounted(() => {
  toolbar.refresh(!!currentVideo.value)
  updateCount()
  window.addEventListener('bewly-download-changed', updateCount)
  document.addEventListener('visibilitychange', updateCount)
  timer = setInterval(() => {
    if (!document.hidden) {
      href.value = location.href
      toolbar.refresh(!!currentVideo.value)
      if (++countTick % 10 === 0 && downloadTaskCount.value)
        updateCount()
    }
  }, 1000)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  toolbar.dispose()
  window.removeEventListener('bewly-download-changed', updateCount)
  document.removeEventListener('visibilitychange', updateCount)
})
</script>

<template>
  <div style="display: contents">
    <DownloadDialog
      v-if="downloadTarget"
      :key="downloadTarget.instanceId"
    />
  </div>
</template>
