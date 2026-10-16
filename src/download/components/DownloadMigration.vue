<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

import Button from '~/components/Button.vue'

import { downloadRequest } from '../client'
import { pickLocalFile } from '../toolClient'
import SelectionButton from './SelectionButton.vue'

interface Preview {
  id: string
  profile: string
  changes: { key: string, before: unknown, after: unknown }[]
  total: number
  duplicate: number
  invalid: number
  missingDirectories: number
  warnings: string[]
  sample: { title: string, bvid: string, directory: string }[]
}
const emit = defineEmits<{ (event: 'imported'): void }>()
const config = ref<Preview>()
const history = ref<Preview>()
const keys = ref<string[]>([])
const profile = ref('')
const importHistory = ref(true)
const busy = ref(false)
const error = ref('')
const message = ref('')
const controller = new AbortController()
const labels: Record<string, string> = {
  directory: '保存目录',
  maxConcurrent: '并发数量',
  defaultOptions: '画质、音质、编码和命名',
  features: '功能入口',
  soundTip: '提示音',
  tray: '托盘',
  shutdown: '自动关机',
  listenClipboard: '剪贴板监听',
}
function selectSetting(key: string, value: boolean) {
  keys.value = keys.value.filter(item => item !== key)
  if (value)
    keys.value.push(key)
}
async function previewConfig() {
  busy.value = true
  error.value = ''
  try {
    config.value = await downloadRequest<Preview>('migrationPreview', {
      profile: profile.value || undefined,
    })
    keys.value = config.value.changes.map(change => change.key)
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
async function previewHistory() {
  busy.value = true
  error.value = ''
  try {
    const file = await pickLocalFile('legacy', undefined, controller.signal)
    if (file) {
      history.value = await downloadRequest<Preview>('migrationPreview', {
        settings: false,
        historyFile: file,
      })
    }
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
async function selectProfile() {
  busy.value = true
  try {
    profile.value
      = (await pickLocalFile('directory', profile.value, controller.signal))
      || profile.value
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
async function commit() {
  busy.value = true
  error.value = ''
  let count = 0
  let records = 0
  let covers = 0
  try {
    if (config.value && keys.value.length) {
      const result = await downloadRequest<{ settings: number }>(
        'migrationImport',
        { id: config.value.id, keys: [...keys.value] },
      )
      count = result.settings
      config.value = undefined
    }
    if (history.value && importHistory.value) {
      const result = await downloadRequest<{ imported: number, restoredCovers?: number }>(
        'migrationImport',
        { id: history.value.id, history: true },
      )
      records = result.imported
      covers = result.restoredCovers || 0
      history.value = undefined
    }
    message.value = `已导入 ${count} 项设置、${records} 条历史记录。${covers ? `已补回 ${covers} 张历史封面。` : ''}`
    emit('imported')
    window.dispatchEvent(new Event('bewly-download-changed'))
    window.dispatchEvent(new Event('bewly-download-settings-changed'))
  }
  catch (err) {
    error.value = String((err as Error).message)
    if (count || records) {
      message.value
        = `已有 ${
         count
         } 项设置、${
         records
         } 条记录成功导入，其余未导入。`
      emit('imported')
    }
  }
  finally {
    busy.value = false
  }
}
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <div class="migration bewly-download-ui">
    <p class="hint">
      可选迁移，先预览再导入。读取旧配置前请退出旧版
      Bilidown；历史请在旧版导出为 .bilidownexport。原配置、历史和下载文件保留。
    </p>
    <div class="actions">
      <Button :disabled="busy" @click="previewConfig">
        预览旧配置
      </Button>
      <Button :disabled="busy" @click="selectProfile">
        选择旧资料目录
      </Button>
      <Button :disabled="busy" @click="previewHistory">
        选择历史导出文件
      </Button>
    </div>
    <p v-if="profile" class="hint">
      {{ profile }}
    </p>
    <div v-if="config" class="preview">
      <h3>配置差异</h3>
      <div v-for="change in config.changes" :key="change.key" class="migration-row">
        <SelectionButton :model-value="keys.includes(change.key)" @update:model-value="selectSetting(change.key, $event)">
          {{ labels[change.key] || change.key }}
        </SelectionButton>
        <div>
          <pre>
现在：{{ change.before === undefined ? '尚未保存到助手；当前沿用扩展默认设置' : JSON.stringify(change.before, null, 2) }}
导入后：{{ JSON.stringify(change.after, null, 2) }}</pre>
        </div>
      </div>
      <p v-for="warning in config.warnings" :key="warning" class="hint">
        {{ warning }}
      </p>
    </div>
    <div v-if="history" class="preview">
      <SelectionButton v-model="importHistory">
        导入历史记录
      </SelectionButton>
      <p class="hint">
        共 {{ history.total }} 条，已存在 {{ history.duplicate }} 条，无效 {{ history.invalid }} 条
      </p>
      <p v-for="warning in history.warnings" :key="warning" class="hint">
        {{ warning }}
      </p>
      <p class="hint">
        旧记录仅保存目录，不会自动重新下载，也不会将目录标成已核验的视频文件。
      </p>
      <ul>
        <li v-for="row in history.sample" :key="row.bvid + row.directory">
          {{ row.title }} · {{ row.directory }}
        </li>
      </ul>
    </div>
    <Button
      v-if="config || history"
      type="primary"
      :disabled="busy || (!keys.length && !(history && importHistory))"
      @click="commit"
    >
      导入所选内容
    </Button>
    <p v-if="message" role="status">
      {{ message }}
    </p>
    <p v-if="error" role="alert" class="error">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.migration {
  display: grid;
  gap: 16px;
}
.hint,
li {
  font-size: 12px;
  color: var(--bew-text-2);
  line-height: 1.8;
}
.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.preview {
  display: grid;
  gap: 14px;
  padding: 16px;
  background: var(--bew-fill-1);
  border-radius: var(--bew-radius);
}
.migration-row {
  display: grid;
  gap: 10px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--bew-border-color);
}
.preview pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--bew-text-2);
  margin-top: 8px;
}
.error {
  color: var(--bew-error-color);
}
input {
  accent-color: var(--bew-theme-color);
}
</style>
