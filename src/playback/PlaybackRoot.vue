<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import browser from 'webextension-polyfill'

import Button from '~/components/Button.vue'
import Dialog from '~/components/Dialog.vue'

import { playbackRequest } from './client'
import type { PlaybackDiagnostic, PlaybackSample } from './engine'
import PlaybackSettings from './PlaybackSettings.vue'

const show = ref(false)
const enabled = ref(false)
const diagnostic = ref<PlaybackDiagnostic>()
const buffer = ref(0)
const droppedRatio = ref(0)
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined
let button: HTMLButtonElement | undefined
let waitingStart = 0
let lastTime = 0
let lastSent = 0
let pending = false
let graceUntil = 0
let videoKey = ''
let frames = { total: 0, dropped: 0 }
let disposed = false
const restoreKey = 'bewly-playback-restore'
function currentVideo() {
  return Array.from(document.querySelectorAll('video'))
    .filter(video => video.getBoundingClientRect().height > 0)
    .sort(
      (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
    )[0]
}
function identity() {
  const url = new URL(location.href)
  return {
    bvid: /^\/video\/(BV[0-9A-Za-z]{10})/.exec(url.pathname)?.[1] || '',
    page: Number(url.searchParams.get('p')) || 1,
  }
}
async function status() {
  try {
    const result = await playbackRequest('status')
    if (!disposed) {
      enabled.value = result.enabled
      diagnostic.value = result.diagnostic
      error.value = ''
    }
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
}
function restore(video: HTMLVideoElement) {
  if (video.readyState < 1 || !Number.isFinite(video.duration))
    return
  try {
    const value = JSON.parse(sessionStorage.getItem(restoreKey) || 'null')
    if (!value)
      return
    if (
      Date.now() - value.savedAt > 300000
      || value.bvid !== identity().bvid
      || value.page !== identity().page
    ) {
      sessionStorage.removeItem(restoreKey)
      return
    }
    if (
      !Number.isFinite(value.time)
      || !Number.isFinite(value.volume)
      || !Number.isFinite(value.rate)
    ) {
      sessionStorage.removeItem(restoreKey)
      return
    }
    video.currentTime = Math.min(
      Math.max(0, value.time),
      Math.max(0, video.duration - 0.1),
    )
    video.volume = Math.min(1, Math.max(0, value.volume))
    video.muted = value.muted === true
    video.playbackRate = Math.min(16, Math.max(0.25, value.rate))
    if (value.paused) {
      video.pause()
    }
    else {
      video.play().catch(() => {
        error.value = '已恢复进度，浏览器限制自动播放时请点击播放器继续。'
      })
    }
    sessionStorage.removeItem(restoreKey)
    graceUntil = Date.now() + 5000
  }
  catch {
    sessionStorage.removeItem(restoreKey)
  }
}
function reloadPlayer() {
  const video = currentVideo()
  if (!video)
    return
  sessionStorage.setItem(
    restoreKey,
    JSON.stringify({
      ...identity(),
      savedAt: Date.now(),
      time: video.currentTime,
      volume: video.volume,
      muted: video.muted,
      paused: video.paused,
      rate: video.playbackRate,
    }),
  )
  location.reload()
}
async function allowMissing() {
  error.value = ''
  try {
    const result = await playbackRequest(
      'enable',
      undefined,
      diagnostic.value?.missingOrigins,
    )
    enabled.value = result.enabled
    diagnostic.value = {
      ...diagnostic.value!,
      message: '已授权当前备用线路，将在下一次需要时测试。',
    }
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
}
function storageChanged(
  changes: Record<string, browser.Storage.StorageChange>,
  area: string,
) {
  if (area === 'local' && changes['bewly-playback-settings'])
    status()
}
async function tick() {
  if (document.hidden) {
    waitingStart = 0
    return
  }
  const id = identity()
  const host = id.bvid
    ? document.querySelector('#arc_toolbar_report .video-toolbar-right, #arc_toolbar_report')
    : null
  if (!host) {
    button?.remove()
    button = undefined
    return
  }
  if (!button || !host.contains(button)) {
    button?.remove()
    button = document.createElement('button')
    button.dataset.bewlyPlaybackOptimizer = 'true'
    button.textContent = '播放优化'
    button.style.cssText
      = 'border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;padding:0 12px;white-space:nowrap'
    button.addEventListener('click', () => {
      show.value = true
      status()
    })
    host.append(button)
  }
  button.title = diagnostic.value?.message || '查看自动线路优化与播放诊断'
  const video = currentVideo()
  if (!video)
    return
  restore(video)
  const key = `${id.bvid}:${id.page}`
  if (key !== videoKey) {
    videoKey = key
    waitingStart = 0
    frames = { total: 0, dropped: 0 }
    graceUntil = Date.now() + 3000
  }
  let ahead = 0
  for (let index = 0; index < video.buffered.length; index++) {
    if (
      video.buffered.start(index) <= video.currentTime + 0.1
      && video.buffered.end(index) > video.currentTime
    ) {
      ahead = video.buffered.end(index) - video.currentTime
    }
  }
  buffer.value = ahead
  const quality = video.getVideoPlaybackQuality?.()
  if (quality) {
    const total = quality.totalVideoFrames - frames.total
    droppedRatio.value
      = total > 0
        ? Math.max(
          0,
          Math.min(1, (quality.droppedVideoFrames - frames.dropped) / total),
        )
        : 0
    frames = {
      total: quality.totalVideoFrames,
      dropped: quality.droppedVideoFrames,
    }
  }
  const playing = !video.paused && !video.ended
  if (document.hidden || !playing || video.seeking || Date.now() < graceUntil) {
    waitingStart = 0
  }
  else if (
    ahead < 1
    && (video.readyState < 3 || Math.abs(lastTime - video.currentTime) < 0.05)
  ) {
    waitingStart ||= Date.now()
  }
  else {
    waitingStart = 0
  }
  lastTime = video.currentTime
  if (
    !enabled.value
    || !playing
    || document.hidden
    || pending
    || Date.now() - lastSent < 5000
  ) {
    return
  }
  const sample: PlaybackSample = {
    ...id,
    playing,
    seeking: video.seeking || Date.now() < graceUntil,
    visible: !document.hidden,
    buffer: ahead,
    waitingSeconds: waitingStart ? (Date.now() - waitingStart) / 1000 : 0,
    droppedRatio: droppedRatio.value,
  }
  pending = true
  lastSent = Date.now()
  try {
    const result = await playbackRequest('sample', sample)
    if (!disposed) {
      enabled.value = result.enabled
      diagnostic.value = result.diagnostic
      error.value = ''
    }
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    pending = false
  }
}
function visibilityChanged() {
  waitingStart = 0
  graceUntil = Date.now() + 3000
}
onMounted(() => {
  if (identity().bvid)
    status()
  timer = setInterval(tick, 1000)
  window.addEventListener('bewly-playback-settings-changed', status)
  document.addEventListener('visibilitychange', visibilityChanged)
  browser.storage.onChanged.addListener(storageChanged)
})
onBeforeUnmount(() => {
  disposed = true
  clearInterval(timer)
  button?.remove()
  window.removeEventListener('bewly-playback-settings-changed', status)
  document.removeEventListener('visibilitychange', visibilityChanged)
  browser.storage.onChanged.removeListener(storageChanged)
})
</script>

<template>
  <Dialog
    v-if="show"
    :z-index="10010"
    title="播放优化"
    :width="560"
    max-width="94vw"
    :show-footer="false"
    :confirm-on-enter="false"
    @close="show = false"
  >
    <div class="diagnostics">
      <PlaybackSettings />
      <p>
        当前缓冲 {{ buffer.toFixed(1) }} 秒 · 最近采样丢帧
        {{ (droppedRatio * 100).toFixed(1) }}%
      </p>
      <p v-if="diagnostic" role="status">
        {{ diagnostic.message }}
      </p>
      <p v-if="diagnostic?.hosts.length" class="hint">
        尝试线路：{{ diagnostic.hosts.join("、") }}
      </p>
      <Button v-if="diagnostic?.missingOrigins.length" @click="allowMissing">
        允许当前视频的其他备用线路
      </Button>
      <Button
        v-if="diagnostic?.reloadSuggested"
        type="primary"
        @click="reloadPlayer"
      >
        重载播放器并恢复进度
      </Button>
      <p v-if="error" role="alert" class="error">
        {{ error }}
      </p>
    </div>
  </Dialog>
</template>

<style scoped>
.diagnostics {
  display: grid;
  gap: 16px;
  line-height: 1.8;
}
.hint {
  color: var(--bew-text-2);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.error {
  color: var(--bew-error-color);
}
</style>
