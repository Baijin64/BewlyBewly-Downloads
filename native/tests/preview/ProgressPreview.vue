<script setup lang="ts">
import DownloadProgress from '../../../src/download/components/DownloadProgress.vue'
import type { DownloadTask } from '../../../src/download/types'

const examples = [
  { status: 'downloading', stage: 'video', progress: 4, speed: 21076377, title: '视频下载' },
  { status: 'downloading', stage: 'audio', progress: 68, speed: 512000, title: '音频下载' },
  { status: 'paused', stage: 'video', progress: 42, speed: 21076377, title: '保留暂停进度' },
  { status: 'muxing', stage: 'video', progress: 100, speed: 0, title: '音画合并' },
  { status: 'postprocessing', progress: 100, speed: 0, title: '保存字幕与封面' },
  { status: 'completed', progress: 100, speed: 0, title: '完成' },
  { status: 'failed', progress: 36, speed: 0, title: '失败状态' },
] as Pick<DownloadTask, 'title' | 'status' | 'stage' | 'progress' | 'speed'>[]
</script>

<template>
  <section class="progress-preview">
    <header>
      <h1>下载进度</h1>
      <p>使用 Bewly 主题与现有 Progress 组件 · 模拟数据</p>
    </header>
    <article v-for="task in examples" :key="task.title" class="progress-preview-card">
      <h2>{{ task.title }}</h2>
      <DownloadProgress :task="task" />
    </article>
  </section>
</template>

<style scoped>
.progress-preview { max-width: 1000px; margin: 28px auto; display: grid; gap: 16px; }
.progress-preview header { margin-bottom: 8px; }
.progress-preview h1 { font-size: 24px; margin: 0 0 8px; }
.progress-preview header p { color: var(--bew-text-2); font-size: 13px; }
.progress-preview-card { background: var(--bew-content-solid); border: 1px solid var(--bew-border-color); border-radius: var(--bew-radius); padding: 20px; }
.progress-preview-card h2 { margin: 0 0 16px; font-size: 15px; font-weight: 600; }
</style>
