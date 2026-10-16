<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import Button from '~/components/Button.vue'
import { useBewlyApp } from '~/composables/useAppProvider'

import { downloadRequest } from '../client'
import { openDownloadSelection } from '../state'
import type { HelperStatus } from '../types'
import DownloadSettings from './DownloadSettings.vue'
import DownloadsPanel from './DownloadsPanel.vue'
import DownloadTools from './DownloadTools.vue'
import SelectionButton from './SelectionButton.vue'

const view = ref(
  new URL(location.href).searchParams.get('downloadView') === 'settings'
    ? 'settings'
    : 'tasks',
)
const toolsEnabled = ref(false)
const input = ref('')
const allParts = ref(false)
const error = ref('')
const refreshKey = ref(0)
const { handlePageRefresh, handleReachBottom } = useBewlyApp()
async function loadSettings() {
  try {
    toolsEnabled.value
      = (await downloadRequest<HelperStatus>('health')).settings.features
        ?.tools === true
  }
  catch {
    /* The task list displays connection errors. */
  }
}
function selectLinks() {
  const links = [...new Set(input.value.split(/\s+/).map(value => value.trim()).filter(Boolean))]
  if (!links.length)
    return
  error.value = ''
  openDownloadSelection(links, allParts.value)
}

onMounted(() => {
  loadSettings()
  window.addEventListener('bewly-download-settings-changed', loadSettings)
  handlePageRefresh.value = async () => {
    refreshKey.value++
    await loadSettings()
  }
  handleReachBottom.value = async () => {}
})
onBeforeUnmount(() => {
  window.removeEventListener('bewly-download-settings-changed', loadSettings)
})
</script>

<template>
  <section class="downloader-page bewly-download-ui">
    <header>
      <div>
        <h1>下载器</h1>
        <p>把喜欢的视频留在本地</p>
      </div>
      <div class="actions">
        <SelectionButton
          :model-value="view === 'tasks'"
          @update:model-value="view = 'tasks'"
        >
          下载任务
        </SelectionButton>
        <SelectionButton
          v-if="toolsEnabled"
          :model-value="view === 'tools'"
          @update:model-value="view = 'tools'"
        >
          辅助工具
        </SelectionButton>
        <SelectionButton
          :model-value="view === 'settings'"
          @update:model-value="view = 'settings'"
        >
          下载设置
        </SelectionButton>
      </div>
    </header>
    <template v-if="view === 'tasks'">
      <details class="add-links">
        <summary>粘贴链接 / BV / AV 号批量添加</summary>
        <textarea
          v-model="input"
          rows="3"
          placeholder="每行一个视频链接或 BV / AV 号"
          aria-label="批量视频链接"
          @keydown.stop
        />
        <div class="actions">
          <SelectionButton v-model="allParts">
            每个链接包含全部分 P
          </SelectionButton>
          <Button type="primary" :disabled="!input.trim()" @click="selectLinks">
            解析并选择视频
          </Button>
        </div>
        <p class="hint">
          有合集时自动展示完整列表。勾选后，再选择立即下载或加入待下载。
        </p>
        <p v-if="error" role="alert" class="error">
          {{ error }}
        </p>
      </details>
      <DownloadsPanel :key="refreshKey" />
    </template>
    <DownloadSettings v-else-if="view === 'settings'" />
    <DownloadTools v-else />
  </section>
</template>

<style scoped>
.downloader-page {
  max-width: 1200px;
  margin: 36px auto 80px;
  display: grid;
  gap: 30px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
h1 {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.5px;
}
header p {
  color: var(--bew-text-2);
  margin-top: 8px;
  font-size: 13px;
}
.actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.add-links {
  padding: 20px;
  border: 1px solid var(--bew-border-color);
  background: var(--bew-content-solid);
  border-radius: var(--bew-radius);
}
summary {
  cursor: pointer;
  font-weight: 600;
}
textarea {
  margin: 16px 0;
  padding: 12px;
  width: 100%;
  box-sizing: border-box;
  background: var(--bew-fill-1);
  border: 1px solid var(--bew-border-color);
  color: inherit;
  border-radius: var(--bew-radius);
  resize: vertical;
}
.add-links label {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  margin-right: auto;
}
.add-links p {
  margin-top: 12px;
  font-size: 12px;
  white-space: pre-wrap;
}
.error {
  color: var(--bew-error-color);
}
input {
  accent-color: var(--bew-theme-color);
}
</style>
