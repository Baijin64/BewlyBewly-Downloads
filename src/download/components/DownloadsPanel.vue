<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import Button from '~/components/Button.vue'
import Dialog from '~/components/Dialog.vue'

import { downloadRequest } from '../client'
import { outputLabels, statusLabels } from '../presentation'
import { downloadTaskCount } from '../state'
import { pickLocalFile, runTool } from '../toolClient'
import type {
  DownloadOptions,
  DownloadTask,
  HelperStatus,
  TaskQuery,
} from '../types'
import { defaultOptions, normalizeDownloadOptions } from '../types'
import DownloadOptionsForm from './DownloadOptionsForm.vue'
import DownloadProgress from './DownloadProgress.vue'
import SelectionButton from './SelectionButton.vue'

const data = ref<TaskQuery>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 50,
  counts: { pending: 0, active: 0, completed: 0, failed: 0 },
})
const tab = ref<'pending' | 'active' | 'completed' | 'failed'>('pending')
const tabs = {
  pending: '待下载',
  active: '下载中',
  completed: '已完成',
  failed: '失败 / 已取消',
}
const search = ref('')
const page = ref(1)
const selected = ref<string[]>([])
const error = ref('')
const message = ref('')
const busy = ref(false)
const loading = ref(false)
const confirmation = ref<{ action: string, ids: string[] }>()
const editing = ref(false)
const editOptions = ref<DownloadOptions>({ ...defaultOptions })
let timer: ReturnType<typeof setInterval> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let generation = 0
async function refresh() {
  if (loading.value || disposed)
    return
  loading.value = true
  const current = generation
  try {
    const result = await downloadRequest<TaskQuery>('queryTasks', {
      tab: tab.value,
      search: search.value,
      page: page.value,
      pageSize: 50,
    })
    if (!disposed && current === generation) {
      data.value = result
      downloadTaskCount.value = result.counts.pending + result.counts.active
      error.value = result.storageError || ''
      if (!result.items.length && page.value > 1)
        page.value--
    }
  }
  catch (err) {
    if (!disposed)
      error.value = String((err as Error).message)
  }
  finally {
    loading.value = false
    if (current !== generation && !disposed)
      refresh()
  }
}
watch(tab, () => {
  page.value = 1
  selected.value = []
  generation++
  refresh()
})
watch(page, () => {
  generation++
  refresh()
})
watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    generation++
    refresh()
  }, 300)
})
function toggle(id: string, checked: boolean) {
  selected.value = checked
    ? [...new Set([...selected.value, id])]
    : selected.value.filter(value => value !== id)
}
function selectPage() {
  const all = data.value.items.every(task =>
    selected.value.includes(task.id),
  )
  for (const task of data.value.items) toggle(task.id, !all)
}
async function perform(
  action: string,
  ids = [...selected.value],
  all?: string,
) {
  if ((!ids.length && !all) || busy.value)
    return
  busy.value = true
  error.value = ''
  try {
    let processed = 0
    const failures: string[] = []
    if (all) {
      const result = await downloadRequest<{
        processed: number
        errors: { id: string, error: string }[]
        errorCount: number
      }>('batchAction', { action, all })
      processed = result.processed
      failures.push(...result.errors.map(item => item.error))
    }
    else {
      for (let offset = 0; offset < ids.length; offset += 200) {
        const result = await downloadRequest<{
          results: unknown[]
          errors: { id: string, error: string }[]
        }>('batchAction', {
          ids: ids.slice(offset, offset + 200),
          action,
          ...(action === 'edit' ? { options: editOptions.value } : {}),
        })
        processed += result.results.length
        failures.push(...result.errors.map(item => item.error))
      }
    }
    message.value = `已处理 ${processed} 项。`
    if (failures.length)
      error.value = `${failures.length} 项未处理：${[...new Set(failures)].join('；')}`
    selected.value = []
    editing.value = false
    window.dispatchEvent(new Event('bewly-download-changed'))
    await refresh()
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
async function exportRecords() {
  busy.value = true
  error.value = ''
  try {
    const directory = await pickLocalFile('directory')
    if (directory) {
      const result = await runTool<{ path: string }>({
        op: 'exportHistory',
        directory,
      })
      message.value = `历史记录已导出：${result.path}`
    }
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
async function fileAction(task: DownloadTask, action: string) {
  try {
    await downloadRequest('taskFile', { id: task.id, action })
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
}
function editSelection() {
  const first = data.value.items.find(task =>
    selected.value.includes(task.id),
  )
  editOptions.value = normalizeDownloadOptions(
    first?.options || defaultOptions,
  )
  editing.value = true
}
onMounted(async () => {
  try {
    const health = await downloadRequest<HelperStatus>('health')
    if ((health.protocol || 1) < 2) {
      throw new Error(
        '请更新至 0.2.0 或更高版本的下载助手，以使用持久队列和批量管理。',
      )
    }
    await refresh()
    timer = setInterval(() => {
      if (!document.hidden && !busy.value)
        refresh()
    }, 2000)
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
})
onBeforeUnmount(() => {
  disposed = true
  clearInterval(timer)
  clearTimeout(searchTimer)
})
</script>

<template>
  <div class="downloads-panel bewly-download-ui">
    <nav class="task-tabs" aria-label="下载任务分类">
      <SelectionButton v-for="(label, value) in tabs" :key="value" :model-value="tab === value" @update:model-value="tab = value">
        {{ label }} <span>{{ data.counts[value] }}</span>
      </SelectionButton>
    </nav>
    <div class="actions">
      <input
        v-model="search"
        class="search"
        placeholder="搜索标题、分 P 或 BV 号"
        aria-label="搜索下载任务"
        @keydown.stop
      >
      <Button size="small" :disabled="loading" @click="refresh">
        刷新
      </Button>
      <Button
        v-if="tab === 'pending'"
        size="small"
        type="primary"
        :disabled="busy || !data.counts.pending"
        @click="perform('start', [], 'pending')"
      >
        全部开始
      </Button>
      <Button
        v-if="tab === 'active'"
        size="small"
        :disabled="busy"
        @click="perform('pause', [], 'active')"
      >
        全部暂停
      </Button>
      <Button
        v-if="tab === 'failed'"
        size="small"
        :disabled="busy"
        @click="perform('retry', [], 'failed')"
      >
        全部重试
      </Button>
    </div>
    <div v-if="tab === 'completed'" class="actions">
      <Button size="small" :disabled="busy" @click="exportRecords">
        导出全部已完成记录
      </Button>
    </div>
    <div class="actions selection">
      <Button size="small" @click="selectPage">
        选择本页
      </Button>
      <span class="hint">已选 {{ selected.length }} 项</span>
      <template v-if="selected.length">
        <Button
          v-if="tab === 'pending'"
          size="small"
          type="primary"
          :disabled="busy"
          @click="perform('start')"
        >
          下载所选
        </Button>
        <Button
          v-if="tab === 'active'"
          size="small"
          :disabled="busy"
          @click="perform('pause')"
        >
          暂停
        </Button>
        <Button
          v-if="tab === 'active'"
          size="small"
          :disabled="busy"
          @click="perform('resume')"
        >
          恢复
        </Button>
        <Button
          v-if="tab === 'failed'"
          size="small"
          :disabled="busy"
          @click="perform('retry')"
        >
          重试
        </Button>
        <Button
          v-if="['pending', 'failed'].includes(tab)"
          size="small"
          :disabled="busy"
          @click="editSelection"
        >
          修改所选配置
        </Button>
        <Button
          size="small"
          :disabled="busy"
          @click="confirmation = { action: 'remove', ids: [...selected] }"
        >
          移除记录
        </Button>
        <Button
          v-if="tab === 'completed'"
          size="small"
          type="error"
          :disabled="busy"
          @click="confirmation = { action: 'deleteFiles', ids: [...selected] }"
        >
          删除下载文件
        </Button>
      </template>
    </div>
    <p v-if="error" role="alert" class="error">
      {{ error }}
    </p>
    <p v-if="message" role="status" class="hint">
      {{ message }}
    </p>
    <p v-if="!data.items.length && !loading" class="empty">
      {{
        search
          ? "没有匹配的任务"
          : "这里还没有任务。可以从视频页面添加，也可以在上方粘贴链接。"
      }}
    </p>
    <article v-for="task in data.items" :key="task.id" class="download-task">
      <div class="task-heading">
        <SelectionButton size="small" :model-value="selected.includes(task.id)" :aria-label="`选择 ${task.title}`" @update:model-value="toggle(task.id, $event)">
          {{ selected.includes(task.id) ? '已选' : '选择' }}
        </SelectionButton>
        <div class="task-title">
          <a
            :href="`https://www.bilibili.com/video/${task.bvid}/?p=${task.page || 1}`"
            target="_blank"
            rel="noopener"
          >{{ task.title }}</a>
          <p v-if="task.part !== task.title" class="hint">
            {{ task.part }}
          </p>
          <p class="hint">
            {{
              task.options?.outputs
                ?.map((kind) => outputLabels[kind])
                .join(" · ")
            }}
          </p>
        </div>
        <span class="task-state" :data-status="task.status">{{ statusLabels[task.status] }}</span>
      </div>
      <DownloadProgress :task="task" />
      <p v-if="task.error" class="error">
        {{ task.error }}
      </p>
      <p v-if="task.output" class="hint path">
        {{ task.output }}
      </p>
      <p v-for="warning in task.warnings" :key="warning" class="hint">
        {{ warning }}
      </p>
      <div class="actions">
        <Button
          v-if="task.status === 'pending'"
          size="small"
          :disabled="busy"
          @click="perform('start', [task.id])"
        >
          开始下载
        </Button>
        <Button
          v-if="['queued', 'resolving', 'downloading'].includes(task.status)"
          size="small"
          :disabled="busy"
          @click="perform('pause', [task.id])"
        >
          暂停
        </Button>
        <Button
          v-if="task.status === 'paused'"
          size="small"
          :disabled="busy"
          @click="perform('resume', [task.id])"
        >
          继续
        </Button>
        <Button
          v-if="['failed', 'cancelled'].includes(task.status)"
          size="small"
          :disabled="busy"
          @click="perform('retry', [task.id])"
        >
          重试
        </Button>
        <Button
          v-if="
            task.status === 'completed' && task.output && !task.filesDeleted
          "
          size="small"
          @click="fileAction(task, 'play')"
        >
          播放
        </Button>
        <Button
          v-if="task.output"
          size="small"
          @click="fileAction(task, 'reveal')"
        >
          定位文件
        </Button>
        <Button
          v-if="task.output || task.legacyPath"
          size="small"
          @click="fileAction(task, 'folder')"
        >
          打开目录
        </Button>
        <Button
          v-if="
            ![
              'muxing',
              'postprocessing',
              'completed',
              'cancelled',
              'pending',
            ].includes(task.status)
          "
          size="small"
          :disabled="busy"
          @click="perform('cancel', [task.id])"
        >
          取消
        </Button>
      </div>
    </article>
    <div class="actions pagination">
      <span class="hint">共 {{ data.total }} 项 · 第 {{ page }} /
        {{ Math.max(1, Math.ceil(data.total / 50)) }} 页</span>
      <Button size="small" :disabled="page <= 1 || loading" @click="page--">
        上一页
      </Button>
      <Button
        size="small"
        :disabled="page * 50 >= data.total || loading"
        @click="page++"
      >
        下一页
      </Button>
    </div>
    <Dialog
      v-if="confirmation"
      :z-index="10020"
      :title="
        confirmation.action === 'remove' ? '移除任务记录' : '删除下载文件'
      "
      :confirm-on-enter="false"
      @close="confirmation = undefined"
      @confirm="perform(confirmation!.action, confirmation!.ids)"
    >
      <p>
        {{
          confirmation.action === "remove"
            ? `将移除 ${confirmation.ids.length} 项记录，已下载文件保留。正在下载的任务需先暂停。`
            : `将删除这 ${confirmation.ids.length} 项任务生成的文件，任务记录保留。此操作不可撤销。`
        }}
      </p>
    </Dialog>
    <Dialog
      v-if="editing"
      :z-index="10020"
      title="修改所选任务配置"
      :width="700"
      max-width="94vw"
      content-max-height="70vh"
      :confirm-on-enter="false"
      @close="editing = false"
      @confirm="perform('edit')"
    >
      <p class="hint">
        只修改所选的待下载或失败任务，已有输出文件的任务不会修改。
      </p>
      <DownloadOptionsForm v-model="editOptions" />
    </Dialog>
  </div>
</template>

<style scoped>
.downloads-panel {
  display: grid;
  gap: 18px;
}
.task-tabs {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.task-tabs span {
  font-size: 12px;
  opacity: 0.8;
}
.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}
.search {
  flex: 1;
  min-width: 180px;
  padding: 10px 14px;
  color: inherit;
  background: var(--bew-fill-1);
  border: 1px solid var(--bew-border-color);
  border-radius: var(--bew-radius);
}
.selection {
  min-height: 30px;
}
.hint {
  font-size: 12px;
  line-height: 1.8;
  color: var(--bew-text-2);
}
.error {
  color: var(--bew-error-color);
  overflow-wrap: anywhere;
}
.empty {
  padding: 48px 20px;
  text-align: center;
  color: var(--bew-text-2);
}
.download-task {
  display: grid;
  gap: 12px;
  padding: 20px;
  border: 1px solid var(--bew-border-color);
  border-radius: var(--bew-radius);
  background: var(--bew-content-solid);
}
.task-heading {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.task-title {
  flex: 1;
  min-width: 0;
}
.task-title a {
  font-weight: 650;
}
.task-state {
  color: var(--bew-theme-color);
  font-size: 12px;
  flex-shrink: 0;
}
.path {
  overflow-wrap: anywhere;
}
.pagination {
  justify-content: flex-end;
}
input {
  accent-color: var(--bew-theme-color);
}
</style>
