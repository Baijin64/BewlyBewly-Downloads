<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import Button from '~/components/Button.vue'
import Radio from '~/components/Radio.vue'
import SettingsItem from '~/components/Settings/components/SettingsItem.vue'
import SettingsItemGroup from '~/components/Settings/components/SettingsItemGroup.vue'
import { settings } from '~/logic'
import PlaybackSettings from '~/playback/PlaybackSettings.vue'

import { downloadRequest } from '../client'
import { downloadPreferences, openDownloader } from '../state'
import { pickLocalFile } from '../toolClient'
import type { DownloadOptions, HelperSettings, HelperStatus } from '../types'
import { normalizeDownloadOptions } from '../types'
import { helperAutoStart } from '../wake'
import DownloadMigration from './DownloadMigration.vue'
import DownloadOptionsForm from './DownloadOptionsForm.vue'
import SelectionButton from './SelectionButton.vue'

const helper = ref<HelperStatus>()
const form = ref<HelperSettings>()
const options = ref<DownloadOptions>(
  normalizeDownloadOptions(downloadPreferences.value),
)
const error = ref('')
const message = ref('')
const preview = ref('')
const busy = ref(false)
const controller = new AbortController()
let previewTimer: ReturnType<typeof setTimeout> | undefined
const featureLabels: Record<
  HelperSettings['features'] extends Record<infer K, boolean> ? K : never,
  string
> = {
  cover: '封面',
  audio: '音频',
  xml: 'XML 弹幕',
  ass: 'ASS 弹幕',
  nfo: '保存视频资料（NFO）',
  srt: 'SRT 字幕',
  tools: '辅助工具',
}
async function connect(probe = false) {
  busy.value = true
  error.value = ''
  try {
    helper.value = await downloadRequest<HelperStatus>('health', { connect: probe })
    if ((helper.value.protocol || 1) < 2)
      throw new Error('完整配置需要 0.2.0 或更新的助手，请更新 MSIX 后重试。')
    form.value = JSON.parse(JSON.stringify(helper.value.settings))
    options.value = normalizeDownloadOptions(
      helper.value.settings.defaultOptions || downloadPreferences.value,
    )
    updatePreview()
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
async function save() {
  if (!form.value)
    return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    form.value = await downloadRequest<HelperSettings>('configure', {
      ...form.value,
      defaultOptions: { ...options.value },
    })
    downloadPreferences.value = normalizeDownloadOptions(options.value)
    message.value
      = '已保存。默认选项和目录只影响新任务，已加入的任务保留原配置。'
    window.dispatchEvent(new Event('bewly-download-settings-changed'))
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
async function pickDirectory() {
  busy.value = true
  error.value = ''
  try {
    const path = await pickLocalFile(
      'directory',
      form.value?.directory,
      controller.signal,
    )
    if (path && form.value)
      form.value.directory = path
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
async function openDirectory() {
  try {
    await downloadRequest('taskFile', { action: 'folder' })
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
}
async function updatePreview() {
  if (!form.value)
    return
  try {
    const value = await downloadRequest<{
      directory: string
      basename: string
    }>('previewPath', {
      task: {
        bvid: 'BV1GJ411x7h7',
        cid: 42,
        title: '示例视频',
        part: '第一集',
        page: 1,
        pageCount: 2,
        author: '示例 UP 主',
        uid: 12345,
        pubdate: 1700000000,
      },
      options: options.value,
      directory: form.value.directory,
    })
    preview.value = `${value.directory}\\${value.basename}`
  }
  catch (err) {
    preview.value = String((err as Error).message)
  }
}
watch(
  [options, () => form.value?.directory],
  () => {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(updatePreview, 400)
  },
  { deep: true },
)
onMounted(() => connect(new URL(location.href).searchParams.get('downloadConnect') === '1'))
onBeforeUnmount(() => {
  controller.abort()
  clearTimeout(previewTimer)
})
</script>

<template>
  <div class="download-settings bewly-download-ui">
    <SettingsItemGroup title="网页下载">
      <SettingsItem
        title="显示下载入口"
        desc="视频下方第五个按钮和视频卡片菜单使用统一的下载配置。"
      >
        <Radio v-model="settings.enableDownloads" aria-label="显示下载入口" />
      </SettingsItem>
      <SettingsItem
        title="本地下载助手"
        :desc="
          helper
            ? `${helper.deferred ? '按需待连接' : '已连接'} · ${helper.version}`
            : '首次安装 MSIX 后，从开始菜单打开一次完成连接。'
        "
      >
        <Button :disabled="busy" @click="connect(true)">
          {{ busy ? "处理中…" : "检查连接" }}
        </Button>
      </SettingsItem>
      <p v-if="error" role="alert" class="error">
        {{ error }}
      </p>
      <template v-if="form">
        <SettingsItem title="保存目录">
          <template #bottom>
            <div class="actions">
              <input
                v-model="form.directory"
                class="path"
                aria-label="保存目录"
                @keydown.stop
              >
              <Button :disabled="busy" @click="pickDirectory">
                选择目录
              </Button>
              <Button @click="openDirectory">
                打开已保存目录
              </Button>
            </div>
          </template>
        </SettingsItem>
        <SettingsItem title="同时下载数量">
          <div class="actions concurrency">
            <SelectionButton v-for="count in [1, 2, 3, 4]" :key="count" size="small" :model-value="form.maxConcurrent === count" @update:model-value="form.maxConcurrent = count">
              {{ count }} 个
            </SelectionButton>
          </div>
        </SettingsItem>
      </template>
    </SettingsItemGroup>
    <SettingsItemGroup title="网页播放优化">
      <PlaybackSettings />
    </SettingsItemGroup>
    <template v-if="form">
      <SettingsItemGroup title="功能入口">
        <SettingsItem desc="控制单独下载按钮和工具入口是否显示，不代表每次下载视频都附带下载。">
          <template #bottom>
            <div class="features">
              <SelectionButton v-for="(label, key) in featureLabels" :key="key" v-model="form.features[key]">
                {{ label }}
              </SelectionButton>
            </div>
          </template>
        </SettingsItem>
      </SettingsItemGroup>
      <SettingsItemGroup title="默认下载选项">
        <div class="settings-section-body">
          <DownloadOptionsForm v-model="options" />
          <p class="hint preview">
            命名示例：{{ preview }}（扩展名由输出类型决定）
          </p>
        </div>
      </SettingsItemGroup>
      <SettingsItemGroup title="迁移旧版 Bilidown">
        <div class="settings-section-body">
          <DownloadMigration @imported="connect" />
        </div>
      </SettingsItemGroup>
      <SettingsItemGroup title="后台与系统">
        <SettingsItem title="系统提示音" desc="任务完成后播放系统提示音。">
          <Radio v-model="form.soundTip" aria-label="系统提示音" />
        </SettingsItem>
        <SettingsItem
          title="托盘管理"
          desc="关闭网页后下载继续，可在托盘打开下载器、暂停或退出助手。"
        >
          <Radio v-model="form.tray" aria-label="托盘管理" />
        </SettingsItem>
        <SettingsItem
          title="监听剪贴板"
          desc="仅识别 B 站视频链接和 BV / AV 号；不会自动开始下载。"
        >
          <Radio v-model="form.listenClipboard" aria-label="监听剪贴板" />
        </SettingsItem>
        <SettingsItem
          title="全部完成后自动关机"
          desc="待下载为空且本轮任务全部成功后，显示 30 秒可取消倒计时。"
        >
          <Radio v-model="form.shutdown" aria-label="全部完成后自动关机" />
        </SettingsItem>
        <SettingsItem title="允许按需启动助手" desc="实际下载、加入队列或使用本地功能时启动；空闲后自动退出。关闭后会先询问。">
          <Radio v-model="helperAutoStart" aria-label="允许按需启动助手" />
        </SettingsItem>
        <SettingsItem title="Windows 手动启动后的空闲退出" desc="从开始菜单打开助手时默认常驻；浏览器按需启动不受此选项影响。">
          <Select
            v-model="form.idleExitMinutes"
            :options="[
              { value: 0, label: '保持后台运行' },
              { value: 5, label: '空闲 5 分钟' },
              { value: 15, label: '空闲 15 分钟' },
              { value: 30, label: '空闲 30 分钟' },
            ]"
          />
        </SettingsItem>
      </SettingsItemGroup>
      <div class="actions">
        <Button
          type="primary"
          :disabled="busy || !options.outputs.length"
          @click="save"
        >
          保存下载设置
        </Button><Button @click="openDownloader">
          打开下载器
        </Button>
      </div>
      <p v-if="message" role="status" class="hint">
        {{ message }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.download-settings {
  display: grid;
  gap: 20px;
}
.actions,
.features {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}
.features {
  gap: 10px;
}
.settings-section-body {
  padding: 16px 0;
}
.concurrency {
  justify-content: flex-end;
  gap: 8px;
}
.features label {
  display: flex;
  gap: 6px;
  align-items: center;
}
.path {
  flex: 1;
  min-width: 200px;
  padding: 10px 14px;
  color: inherit;
  border-radius: var(--bew-radius);
  border: 1px solid var(--bew-border-color);
  background: var(--bew-fill-1);
}
.hint {
  font-size: 12px;
  color: var(--bew-text-2);
  line-height: 1.8;
}
.preview {
  margin-top: 16px;
  overflow-wrap: anywhere;
}
.error {
  color: var(--bew-error-color);
}
input {
  accent-color: var(--bew-theme-color);
}
</style>
