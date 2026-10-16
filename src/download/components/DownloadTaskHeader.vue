<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { outputLabels, statusLabels } from '../presentation'
import { taskCoverUrl, taskTime } from '../taskMetadata'
import type { DownloadTask } from '../types'

const props = defineProps<{ task: DownloadTask }>()
const cover = computed(() => taskCoverUrl(props.task.cover))
const coverFailed = ref(false)
watch(cover, () => coverFailed.value = false)
const videoUrl = computed(() => `https://www.bilibili.com/video/${encodeURIComponent(props.task.bvid)}/?p=${props.task.page || 1}`)
const author = computed(() => props.task.author?.trim() || 'UP 主未记录')
const authorUrl = computed(() => Number.isSafeInteger(props.task.uid) && props.task.uid! > 0 ? `https://space.bilibili.com/${props.task.uid}` : undefined)
const time = computed(() => taskTime(props.task))
const outputs = computed(() => props.task.options?.outputs?.map(kind => outputLabels[kind]).join(' · '))
</script>

<template>
  <div class="task-details">
    <a class="task-cover" :href="videoUrl" target="_blank" rel="noopener noreferrer" :aria-label="`打开视频：${task.title}`">
      <img
        v-if="cover && !coverFailed" :src="cover" :alt="`${task.title}的封面`" loading="lazy" decoding="async"
        referrerpolicy="no-referrer" @error="coverFailed = true"
      >
      <span v-else class="cover-placeholder">暂无封面</span>
    </a>
    <div class="task-info">
      <a class="task-video-title" :href="videoUrl" target="_blank" rel="noopener noreferrer" :title="task.title">{{ task.title }}</a>
      <p v-if="task.part && task.part !== task.title" class="task-part" :title="task.part">
        {{ task.part }}
      </p>
      <div class="task-author">
        <span class="up-label" aria-hidden="true">UP</span>
        <a v-if="authorUrl" :href="authorUrl" target="_blank" rel="noopener noreferrer" :title="author">{{ author }}</a>
        <span v-else :title="author">{{ author }}</span>
      </div>
      <p v-if="outputs" class="task-outputs">
        {{ outputs }}
      </p>
    </div>
    <div class="task-summary">
      <time v-if="time.text" :datetime="time.dateTime" :title="`${time.label} · 按记录时间显示`">{{ time.label }} {{ time.text }}</time>
      <span v-else class="task-time-missing">{{ time.label }}未记录</span>
      <span class="task-state" :data-status="task.status">{{ statusLabels[task.status] }}</span>
    </div>
  </div>
</template>

<style scoped>
.task-details {
  display: grid;
  grid-template-columns: 156px minmax(0, 1fr) auto;
  gap: 12px 16px;
  align-items: start;
  flex: 1;
  min-width: 0;
}
.task-cover {
  display: block;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: var(--bew-radius-half);
  background: var(--bew-fill-2);
  color: var(--bew-text-2);
}
.task-cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-placeholder {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.task-info {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.task-video-title {
  font-weight: 650;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.task-video-title:hover,
.task-author a:hover {
  color: var(--bew-theme-color);
}
.task-part,
.task-outputs,
.task-author,
.task-summary {
  font-size: 12px;
  line-height: 1.5;
  color: var(--bew-text-2);
}
.task-part {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-author {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.task-author a,
.task-author > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.up-label {
  padding: 0 3px;
  border: 1px solid var(--bew-text-3, var(--bew-text-2));
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
  line-height: 1.2;
  flex-shrink: 0;
}
.task-summary {
  display: grid;
  justify-items: end;
  gap: 10px;
  white-space: nowrap;
}
.task-state {
  color: var(--bew-theme-color);
}
.task-state[data-status="failed"] {
  color: var(--bew-error-color);
}
@container (max-width: 680px) {
  .task-details {
    grid-template-columns: 112px minmax(0, 1fr);
    gap: 10px 12px;
  }
  .task-summary {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 6px 12px;
    white-space: normal;
  }
}
@media (max-width: 560px) {
  .task-details {
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 10px;
  }
  .task-summary {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    white-space: normal;
  }
}
</style>
