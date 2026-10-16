<script setup lang="ts">
import { computed } from 'vue'

import Progress from '~/components/Progress.vue'

import type { DownloadTask } from '../types'

const props = defineProps<{ task: Pick<DownloadTask, 'title' | 'status' | 'stage' | 'progress' | 'speed'> }>()
const indeterminate = computed(() => ['queued', 'resolving', 'muxing', 'postprocessing'].includes(props.task.status))
const percentage = computed(() => {
  if (props.task.status === 'completed')
    return 100
  const value = Number(props.task.progress)
  return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : 0
})
const label = computed(() => {
  const { status, stage } = props.task
  if (status === 'downloading')
    return stage === 'audio' ? '下载音频' : stage === 'video' ? '下载视频' : '正在下载'
  return ({ pending: '等待开始', queued: '等待下载', resolving: '正在解析', paused: '已暂停', muxing: '正在合并媒体', postprocessing: '正在保存附件', completed: '下载完成', failed: '处理失败', cancelled: '已取消' })[status] || '等待开始'
})
const speed = computed(() => {
  const value = Number(props.task.speed)
  if (!Number.isFinite(value) || value <= 0)
    return '等待数据…'
  if (value >= 1048576)
    return `${(value / 1048576).toFixed(1)} MB/s`
  if (value >= 1024)
    return `${Math.round(value / 1024)} KB/s`
  return `${Math.round(value)} B/s`
})
const color = computed(() => props.task.status === 'failed' ? 'var(--bew-error-color)' : ['paused', 'cancelled'].includes(props.task.status) ? 'var(--bew-text-3, var(--bew-text-2))' : 'var(--bew-theme-color)')
const valueText = computed(() => indeterminate.value ? `${label.value}，进度暂不可计量` : `${label.value}，${percentage.value}%`)
</script>

<template>
  <div v-if="task.status !== 'pending'" class="download-progress" :data-status="task.status">
    <div
      class="progress-track"
      :class="{ 'is-indeterminate': indeterminate }"
      role="progressbar"
      :aria-label="`${task.title}：${label}`"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="indeterminate ? undefined : percentage"
      :aria-valuetext="valueText"
    >
      <Progress class="progress-fill" :percentage="indeterminate ? 30 : percentage" :color="color" :height="6" />
    </div>
    <div class="progress-meta">
      <span class="progress-stage">{{ label }}</span>
      <span class="progress-metrics">
        <span v-if="task.status === 'downloading'" class="progress-speed">{{ speed }}</span>
        <span v-if="!indeterminate" class="progress-percentage">{{ percentage }}%</span>
        <span v-else class="progress-detail">{{ ['queued', 'resolving'].includes(task.status) ? '准备中' : '处理中' }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.download-progress {
  display: grid;
  gap: 9px;
  min-width: 0;
}
.progress-track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bew-fill-2);
}
.progress-fill {
  border-radius: inherit;
  transition: width 350ms ease;
}
.progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bew-text-2);
}
.progress-stage {
  min-width: 0;
}
.progress-metrics {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 14px;
  font-variant-numeric: tabular-nums;
}
.progress-percentage {
  min-width: 3ch;
  text-align: right;
  color: var(--bew-text-1);
  font-weight: 600;
}
.progress-speed,
.progress-detail {
  white-space: nowrap;
}
.is-indeterminate .progress-fill {
  transition: none;
  animation: progress-processing 1.8s ease-in-out infinite;
}
.download-progress[data-status="completed"] .progress-fill {
  opacity: 0.7;
}
.download-progress[data-status="cancelled"] .progress-fill {
  opacity: 0.6;
}
.download-progress[data-status="failed"] .progress-stage {
  color: var(--bew-error-color);
}
@keyframes progress-processing {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .progress-fill {
    transition: none;
  }
  .is-indeterminate .progress-fill {
    animation: none;
    transform: translateX(115%);
  }
}
@media (forced-colors: active) {
  .progress-track {
    outline: 1px solid GrayText;
    background: Canvas;
  }
  .progress-fill {
    background: Highlight !important;
  }
}
</style>
