<script setup lang="ts">
import { provide, ref, watch } from 'vue'

import Dock from '../../../src/components/Dock/Dock.vue'
import DownloaderPage from '../../../src/download/components/DownloaderPage.vue'
import DownloadRoot from '../../../src/download/components/DownloadRoot.vue'
import { openVideoDownload } from '../../../src/download/state'
import { AppPage } from '../../../src/enums/appEnums'
import { setInstalled } from './browser.mjs'
import ProgressPreview from './ProgressPreview.vue'

const root = ref<HTMLElement>()
const dark = ref(false)
const narrow = ref(false)
const progressOnly = new URLSearchParams(location.search).has('progress')
const themeColor = ref('#00A1D6')
watch(themeColor, value => document.documentElement.style.setProperty('--bew-theme-color', value), { immediate: true })
document.documentElement.classList.add('bewly-design')
watch(dark, value => document.documentElement.classList.toggle('dark', value), { immediate: true })
provide('BEWLY_APP', { mainAppRef: root, reachTop: ref(true), handlePageRefresh: ref(), handleReachBottom: ref() })
</script>
<template>
  <main ref="root" class="preview" :class="{ narrow }">
    <div class="preview-controls">
      <span>界面验证 · 模拟任务</span>
      <Button size="small" type="primary" @click="openVideoDownload('BV1GJ411x7h7')">打开下载弹窗</Button>
      <Button size="small" @click="dark = !dark">切换明暗主题</Button>
      <Button size="small" @click="themeColor = themeColor === '#00A1D6' ? '#8B5CF6' : '#00A1D6'">切换主题色</Button>
      <Button size="small" @click="narrow = !narrow">切换窄屏预览</Button>
      <Button size="small" @click="setInstalled(false); openVideoDownload('BV1GJ411x7h7')">模拟断开</Button>
      <Button size="small" @click="setInstalled(true)">恢复连接</Button>
    </div>
    <ProgressPreview v-if="progressOnly" />
    <template v-else>
      <DownloaderPage />
      <Dock :activated-page="AppPage.Downloads" />
      <DownloadRoot />
    </template>
  </main>
</template>
<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--bew-text-1); background: var(--bew-bg, var(--bew-content-alt-solid)); }
.preview { min-height: 100vh; padding: 20px 110px 40px 60px; }
.preview-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 12px; color: var(--bew-text-2); max-width: 1200px; margin: auto; }
.preview .dock-wrap { left: 0; }
.preview.narrow .downloader-page { max-width: 480px; }
</style>
