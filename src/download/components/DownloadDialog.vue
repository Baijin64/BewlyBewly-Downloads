<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import Button from '~/components/Button.vue'
import Dialog from '~/components/Dialog.vue'

import { downloadRequest } from '../client'
import { outputLabels } from '../presentation'
import type { SelectionRow } from '../selection'
import { selectionGroup, selectionRows } from '../selection'
import { downloadPreferences, downloadTarget, openDownloader } from '../state'
import type {
  AvailableAudioFormat,
  AvailableMediaFormats,
  AvailableVideoFormat,
  DownloadTask,
  DownloadVideo,
  HelperStatus,
  OutputKind,
} from '../types'
import { normalizeDownloadOptions } from '../types'
import DownloadOptionsForm from './DownloadOptionsForm.vue'
import SelectionButton from './SelectionButton.vue'

const target = downloadTarget.value!
const info = ref<DownloadVideo>()
const sources = ref<DownloadVideo[]>([])
const helper = ref<HelperStatus>()
const selected = ref<string[]>([])
const options = ref(normalizeDownloadOptions(downloadPreferences.value))
const error = ref('')
const errors = ref<string[]>([])
const loading = ref(false)
const result = ref('')
const collectionView = ref(false)
const expanded = ref<string[]>([])
const loaded = ref<Record<string, DownloadVideo>>({})
const filter = ref('')
const range = ref('')
const remember = ref(false)
const preview = ref('')
const subtitleTracks = ref<{ language: string, label: string }[]>()
const subtitleError = ref('')
const availableFormats = ref<AvailableVideoFormat[]>()
const availableAudioFormats = ref<AvailableAudioFormat[]>()
const qualityLoading = ref(false)
const qualityError = ref('')
const qualityReference = ref('')
const formatCache = new Map<string, AvailableMediaFormats>()
const formatRequests = new Map<string, Promise<AvailableMediaFormats>>()
let qualityIdentity = ''
let subtitleIdentity = ''
const progress = ref('')
const stopped = ref(false)
let disposed = false
let previewTimer: ReturnType<typeof setTimeout> | undefined
let previewSequence = 0
const key = (row: SelectionRow) => `${row.bvid}:${row.cid ?? '*'}`
const rows = computed(() => selectionRows(sources.value, collectionView.value, expanded.value, loaded.value))

const visibleRows = computed(() =>
  rows.value.filter(row =>
    row.title.toLowerCase().includes(filter.value.toLowerCase()),
  ),
)
const quickKinds = computed(() =>
  (['cover', 'audio', 'xml', 'ass', 'srt', 'nfo'] as OutputKind[]).filter(
    kind =>
      helper.value?.settings.features?.[
        kind as keyof HelperStatus['settings']['features']
      ],
  ),
)
function checked(row: SelectionRow) {
  return row.cid
    ? selected.value.includes(key(row))
    || selected.value.includes(`${row.bvid}:*`)
    : selected.value.includes(`${row.bvid}:*`)
    || !!loaded.value[row.bvid]?.pages.every(part =>
      selected.value.includes(`${row.bvid}:${part.cid}`),
    )
}
function partiallyChecked(row: SelectionRow) {
  return (
    !row.cid
    && !checked(row)
    && selected.value.some(id => id.startsWith(`${row.bvid}:`))
  )
}
const helperUpdateRequired = computed(() => options.value.audioQuality === 'auto' && options.value.outputs.some(kind => ['video', 'audio', 'mp3'].includes(kind)) && !helper.value?.capabilities?.includes('audio-highest'))
async function checkHelperUpdate() {
  try {
    helper.value = await downloadRequest<HelperStatus>('health')
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
}
function close() {
  if (downloadTarget.value?.instanceId === target.instanceId)
    downloadTarget.value = undefined
}
function toggle(row: SelectionRow, value: boolean) {
  if (!row.available)
    return
  if (!row.cid) {
    selected.value = selected.value.filter(
      id => !id.startsWith(`${row.bvid}:`),
    )
  }
  else if (selected.value.includes(`${row.bvid}:*`)) {
    selected.value = selected.value.filter(id => id !== `${row.bvid}:*`)
    selected.value.push(
      ...(loaded.value[row.bvid]?.pages || []).map(
        part => `${row.bvid}:${part.cid}`,
      ),
    )
  }
  selected.value = selected.value.filter(id => id !== key(row))
  if (value)
    selected.value.push(key(row))
}
function selectVisible(invert = false) {
  const allChecked = visibleRows.value
    .filter(row => row.available)
    .every(checked)
  for (const row of visibleRows.value)
    toggle(row, invert ? !checked(row) : !allChecked)
}
function selectRange() {
  try {
    const indices = new Set<number>()
    for (const segment of range.value.split(/[,，\s]+/).filter(Boolean)) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(segment)
      if (!match)
        throw new Error('范围格式示例：1-10, 13')
      const start = Number(match[1])
      const end = Number(match[2] || match[1])
      if (start < 1 || end < start || end > visibleRows.value.length)
        throw new Error('范围超出当前列表')
      for (let index = start; index <= end; index++) indices.add(index)
    }
    for (const index of indices) toggle(visibleRows.value[index - 1], true)
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
}
async function expand(bvid: string) {
  loading.value = true
  try {
    loaded.value[bvid] ||= await downloadRequest<DownloadVideo>('inspect', {
      video: bvid,
    })
    expanded.value = expanded.value.includes(bvid)
      ? expanded.value.filter(id => id !== bvid)
      : [...expanded.value, bvid]
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    loading.value = false
  }
}
async function load() {
  loading.value = true
  error.value = ''
  try {
    helper.value = await downloadRequest<HelperStatus>('health')
    if ((helper.value.protocol || 1) < 2) {
      throw new Error(
        '这些功能需要 0.2.0 或更新的下载助手，请更新 MSIX 后重试。',
      )
    }
    if (!helper.value.engineInstalled)
      throw new Error('下载引擎缺失，请重新安装下载助手')
    const videos: DownloadVideo[] = []
    const chosen = new Set<string>()
    const failures: string[] = []
    const links = target.videos || [target.video]
    for (const [index, link] of links.entries()) {
      if (disposed)
        return
      progress.value = `正在解析链接 ${index + 1} / ${links.length}`
      try {
        const video = await downloadRequest<DownloadVideo>('inspect', { video: link })
        if (disposed)
          return
        if (!video.pages.length)
          throw new Error('没有可用分 P')
        loaded.value[video.bvid] = video
        videos.push(video)
        const page = video.requestedPage || 1
        const part = video.pages.find(part => part.cid === target.cid) || video.pages.find(part => part.page === page) || video.pages[0]
        for (const selectedPart of target.allParts ? video.pages : [part])
          chosen.add(`${video.bvid}:${selectedPart.cid}`)
      }
      catch (err) {
        failures.push(`${link}：${String((err as Error).message)}`)
      }
    }
    if (!videos.length)
      throw new Error(failures.join('；') || '没有可用视频')
    sources.value = videos
    info.value = videos[0]
    collectionView.value = videos.some(video => video.collection?.sections.some(section => section.videos.length))
    selected.value = [...chosen]
    error.value = failures.length ? `以下链接未加入选择列表：\n${failures.join('\n')}` : ''
    options.value = normalizeDownloadOptions(helper.value.settings.defaultOptions || downloadPreferences.value)
    progress.value = ''
    updatePreview()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}
async function updateAvailableFormats(video: DownloadVideo, cid: number) {
  const id = `${video.bvid}:${cid}`
  if (qualityIdentity === id)
    return
  qualityIdentity = id
  qualityReference.value = video.title + (video.pages.length > 1 ? ` · P${video.pages.find(part => part.cid === cid)?.page || 1}` : '')
  qualityError.value = ''
  const cached = formatCache.get(id)
  availableFormats.value = cached?.video
  availableAudioFormats.value = cached?.audio
  qualityLoading.value = !cached
  if (cached)
    return
  const request = formatRequests.get(id) || downloadRequest<AvailableMediaFormats>('inspectFormats', { video: video.bvid, cid })
  formatRequests.set(id, request)
  try {
    const formats = await request
    formatCache.set(id, formats)
    if (!disposed && qualityIdentity === id) {
      availableFormats.value = formats.video
      availableAudioFormats.value = formats.audio
    }
  }
  catch (err) {
    if (!disposed && qualityIdentity === id)
      qualityError.value = `音视频规格暂未读到：${String((err as Error).message)}。下载时会重新检查。`
  }
  finally {
    if (formatRequests.get(id) === request)
      formatRequests.delete(id)
    if (!disposed && qualityIdentity === id)
      qualityLoading.value = false
  }
}
function retryQualities() {
  qualityIdentity = ''
  void updatePreview()
}
async function updatePreview() {
  if (!info.value || !helper.value || disposed)
    return
  try {
    const sequence = ++previewSequence
    const [bvid, cid] = (selected.value[0] || `${info.value.bvid}:*`).split(
      ':',
    )
    const video
      = loaded.value[bvid]
      || (await downloadRequest<DownloadVideo>('inspect', { video: bvid }))
    loaded.value[bvid] = video
    const part
      = video.pages.find(part => part.cid === Number(cid)) || video.pages[0]
    void updateAvailableFormats(video, part.cid)
    const group = collectionView.value ? selectionGroup(sources.value, bvid) : undefined
    if (
      options.value.outputs.includes('srt')
      && subtitleIdentity !== `${bvid}:${part.cid}`
    ) {
      subtitleIdentity = `${bvid}:${part.cid}`
      subtitleError.value = ''
      try {
        const tracks = await downloadRequest<
          { language: string, label: string }[]
        >('inspectSubtitles', { video: bvid, cid: part.cid })
        if (subtitleIdentity === `${bvid}:${part.cid}`)
          subtitleTracks.value = tracks
      }
      catch (err) {
        subtitleError.value = `字幕语言暂未读取：${String((err as Error).message)}`
      }
    }
    const path = await downloadRequest<{ directory: string, basename: string }>(
      'previewPath',
      {
        task: {
          ...video,
          cid: part.cid,
          part: part.title,
          page: part.page,
          pageCount: video.pages.length,
          group,
        },
        options: options.value,
      },
    )
    if (!disposed && sequence === previewSequence)
      preview.value = `${path.directory}\\${path.basename}（按输出类型添加扩展名）`
  }
  catch (err) {
    preview.value = String((err as Error).message)
  }
}
watch(
  [options, selected, collectionView],
  () => {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(updatePreview, 400)
  },
  { deep: true },
)
async function submit(start: boolean) {
  if (!selected.value.length || !info.value || !options.value.outputs.length)
    return
  if (helperUpdateRequired.value) {
    error.value = '自动最高音质需要下载助手 0.2.2，请更新后重新检查连接。'
    return
  }
  loading.value = true
  error.value = ''
  errors.value = []
  stopped.value = false
  const groups = new Map<string, Set<string>>()
  for (const id of selected.value) {
    const [bvid, cid] = id.split(':')
    if (!groups.has(bvid))
      groups.set(bvid, new Set())
    groups.get(bvid)!.add(cid)
  }
  let added = 0
  let duplicates = 0
  let index = 0
  for (const [bvid, cids] of groups) {
    if (stopped.value || disposed)
      break
    progress.value = `正在添加 ${++index} / ${groups.size}`
    try {
      const video
        = loaded.value[bvid]
        || (await downloadRequest<DownloadVideo>('inspect', { video: bvid }))
      const ids = cids.has('*')
        ? video.pages.map(part => part.cid)
        : [...cids].map(Number)
      const group = collectionView.value ? selectionGroup(sources.value, bvid) : undefined
      const tasks = await downloadRequest<DownloadTask[]>(
        start ? 'createTasks' : 'stageTasks',
        { video: bvid, cids: ids, options: { ...options.value }, group },
      )
      added += tasks.filter(task => !task.duplicate).length
      duplicates += tasks.filter(task => task.duplicate).length
      window.dispatchEvent(new Event('bewly-download-changed'))
    }
    catch (err) {
      errors.value.push(`${bvid}：${String((err as Error).message)}`)
    }
  }
  if (remember.value) {
    downloadPreferences.value = normalizeDownloadOptions(options.value)
    try {
      await downloadRequest('configure', {
        defaultOptions: { ...options.value },
      })
    }
    catch (err) {
      errors.value.push(`默认配置未保存：${String((err as Error).message)}`)
    }
  }
  result.value = `${(start ? '已开始排队下载 ' : '已加入待下载 ') + added} 项，重复跳过 ${duplicates} 项。${stopped.value ? '已停止继续添加，已加入的任务仍保留。' : ''}`
  loading.value = false
}
onMounted(load)
onBeforeUnmount(() => {
  disposed = true
  stopped.value = true
  clearTimeout(previewTimer)
})
</script>

<template>
  <Dialog
    :z-index="10010"
    title="下载视频"
    :width="760"
    max-width="94vw"
    content-max-height="76vh"
    :show-footer="false"
    :confirm-on-enter="false"
    @close="close"
  >
    <div class="download-dialog bewly-download-ui">
      <p v-if="error" role="alert" class="error">
        {{ error }}
      </p>
      <template v-if="result">
        <p role="status">
          {{ result }}
        </p>
        <p v-for="message in errors" :key="message" class="error">
          {{ message }}
        </p>
        <div class="actions">
          <Button
            type="primary"
            @click="
              downloadTarget = undefined;
              openDownloader();
            "
          >
            打开下载器
          </Button>
          <Button
            @click="
              result = '';
              errors = [];
            "
          >
            返回选择
          </Button>
        </div>
      </template>
      <template v-else-if="info">
        <div>
          <h3>{{ sources.length > 1 ? `批量选择（${sources.length} 个链接）` : info.title }}</h3>
          <p class="hint">
            {{ sources.length > 1 ? "已合并重复视频；点选需要的内容再添加任务。" : `${info.author} · ${info.pages.length} 个分 P` }}
          </p>
        </div>
        <p v-if="sources.length === 1 && collectionView && info.collection" class="hint">
          合集：{{ info.collection.title }}
        </p>
        <div class="actions">
          <SelectionButton
            v-if="sources.length === 1 && info.collection"
            size="small"
            :model-value="collectionView"
            @update:model-value="collectionView = $event"
          >
            {{ collectionView ? "返回当前视频" : "查看整个合集" }}
          </SelectionButton>
          <Button size="small" @click="selectVisible()">
            全选 / 清空当前列表
          </Button>
          <Button size="small" @click="selectVisible(true)">
            反选
          </Button>
        </div>
        <div class="filters">
          <input
            v-model="filter"
            placeholder="筛选标题"
            aria-label="筛选标题"
            @keydown.stop
          >
          <input
            v-model="range"
            placeholder="范围：1-10, 13"
            aria-label="选择范围"
            @keydown.stop
          >
          <Button size="small" @click="selectRange">
            选择范围
          </Button>
        </div>
        <p v-if="collectionView" class="hint">
          点选整视频包含其全部分 P；展开后可单独选择。当前视频默认仅选中当前分
          P。
        </p>
        <div class="part-list">
          <template
            v-for="(row, index) in visibleRows"
            :key="key(row) + row.section + index"
          >
            <h4
              v-if="
                index === 0 || row.section !== visibleRows[index - 1].section
              "
            >
              {{ row.section }}
            </h4>
            <div class="part-row">
              <SelectionButton
                block :model-value="checked(row)" :mixed="partiallyChecked(row)" :disabled="!row.available || loading" :aria-label="`选择 ${row.page ? `P${row.page} ` : ''}${row.title}`"
                @update:model-value="toggle(row, $event)"
              >
                <span class="part-index">{{ index + 1 }}</span>
                <span>{{ row.page ? `P${row.page} ` : "" }}{{ row.title }}{{ !row.available ? "（已失效）" : "" }}</span>
              </SelectionButton>
              <Button
                v-if="collectionView && (!row.page || row.page === 1)"
                size="small"
                :disabled="loading"
                @click="expand(row.bvid)"
              >
                {{ expanded.includes(row.bvid) ? "收起" : "分 P" }}
              </Button>
            </div>
          </template>
        </div>
        <div v-if="quickKinds.length" class="actions">
          <span class="hint">单独下载：</span>
          <SelectionButton
            v-for="kind in quickKinds"
            :key="kind"
            size="small"
            :model-value="options.outputs.length === 1 && options.outputs[0] === kind"
            @update:model-value="options = { ...options, outputs: [kind] }"
          >
            仅{{ outputLabels[kind] }}
          </SelectionButton>
        </div>
        <DownloadOptionsForm
          v-model="options"
          :subtitle-tracks="subtitleTracks"
          :available-formats="availableFormats"
          :available-audio-formats="availableAudioFormats"
          :quality-loading="qualityLoading"
        />
        <div v-if="helperUpdateRequired" class="actions">
          <p class="hint">
            自动最高音质需要下载助手 0.2.2。请更新助手后检查连接；手动指定音质继续沿用所选规格。
          </p>
          <Button size="small" @click="checkHelperUpdate">
            检查助手更新
          </Button>
        </div>
        <p v-if="qualityReference" class="hint">
          当前音视频规格参考：{{ qualityReference }}。选择“最高可用”时，每个视频、分 P 都会分别取其可用的最高画质和音质。
        </p>
        <div v-if="qualityError" class="actions">
          <p class="hint">
            {{ qualityError }}
          </p>
          <Button size="small" :disabled="qualityLoading" @click="retryQualities">
            重新读取规格
          </Button>
        </div>
        <p v-if="subtitleError && options.outputs.includes('srt')" class="hint">
          {{ subtitleError }}
        </p>
        <p class="hint preview">
          保存预览：{{ preview || helper?.settings.directory }}
        </p>
        <SelectionButton v-model="remember">
          将本次选项保存为默认配置
        </SelectionButton>
        <p v-if="loading" role="status">
          {{ progress || "正在读取…" }}
        </p>
        <div class="actions">
          <Button
            type="primary"
            :disabled="loading || helperUpdateRequired || !selected.length || !options.outputs.length"
            @click="submit(true)"
          >
            立即下载（{{ selected.length }}）
          </Button>
          <Button
            :disabled="loading || helperUpdateRequired || !selected.length || !options.outputs.length"
            @click="submit(false)"
          >
            加入待下载
          </Button>
          <Button v-if="loading && progress" @click="stopped = true">
            停止继续添加
          </Button>
        </div>
      </template>
      <template v-else>
        <p v-if="loading" role="status">
          {{ progress || "正在连接下载助手…" }}
        </p>
        <Button :disabled="loading" @click="load">
          重试连接
        </Button>
      </template>
    </div>
  </Dialog>
</template>

<style scoped>
.download-dialog {
  display: grid;
  gap: 16px;
}
h3 {
  font-size: 18px;
  font-weight: 650;
}
h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--bew-text-2);
  padding: 4px 0;
}
.hint {
  color: var(--bew-text-2);
  font-size: 12px;
  line-height: 1.8;
}
.error {
  color: var(--bew-error-color);
  overflow-wrap: anywhere;
}
.actions,
.filters {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}
.filters > input {
  flex: 1;
  min-width: 120px;
}
.part-list {
  display: grid;
  gap: 10px;
  max-height: 240px;
  overflow: auto;
  padding: 12px;
  background: var(--bew-fill-1);
  border-radius: var(--bew-radius);
}
.part-row {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}
.part-index {
  opacity: 0.7;
  flex-shrink: 0;
}
.preview {
  overflow-wrap: anywhere;
}
input {
  accent-color: var(--bew-theme-color);
}
input:not([type="checkbox"]) {
  padding: 9px 12px;
  color: inherit;
  border-radius: var(--bew-radius);
  background: var(--bew-fill-1);
  border: 1px solid var(--bew-border-color);
}
</style>
