<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import Button from '~/components/Button.vue'

import { downloadRequest } from '../client'
import { pickLocalFile, runTool } from '../toolClient'
import type { HelperStatus } from '../types'
import SelectionButton from './SelectionButton.vue'

const operation = ref('convertId')
const input = ref('')
const source = ref('')
const video = ref('')
const audio = ref('')
const directory = ref('')
const lineBreaks = ref(true)
const busy = ref(false)
const error = ref('')
const result = ref('')
const controller = new AbortController()
const operations = [
  { value: 'convertId', label: 'BV / AV 转换' },
  { value: 'joinTime', label: '入站时间查询' },
  { value: 'ccToSrt', label: 'CC 字幕转 SRT' },
  { value: 'srtToText', label: 'SRT 转纯文本' },
  { value: 'audioToMp3', label: '音频转 MP3' },
  { value: 'mux', label: '手动音视频混流' },
]
async function pick(
  field: 'source' | 'video' | 'audio' | 'directory',
  kind: string,
) {
  busy.value = true
  error.value = ''
  try {
    const path = await pickLocalFile(kind, undefined, controller.signal)
    if (path) {
      if (field === 'source')
        source.value = path
      else if (field === 'video')
        video.value = path
      else if (field === 'audio')
        audio.value = path
      else directory.value = path
    }
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
async function execute() {
  busy.value = true
  error.value = ''
  result.value = ''
  try {
    const output = await runTool<{ path?: string, text?: string }>(
      {
        op: operation.value,
        input: input.value,
        mid: input.value,
        source: source.value,
        video: video.value,
        audio: audio.value,
        directory: directory.value,
        lineBreaks: lineBreaks.value,
      },
      controller.signal,
    )
    result.value = output.path ? `已保存：${output.path}` : output.text || ''
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
  finally {
    busy.value = false
  }
}
onMounted(async () => {
  try {
    directory.value = (
      await downloadRequest<HelperStatus>('health')
    ).settings.directory
  }
  catch (err) {
    error.value = String((err as Error).message)
  }
})
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <div class="download-tools bewly-download-ui">
    <h2>辅助工具</h2>
    <p class="hint">
      文件处理在本地助手内完成，源文件保留，输出文件已存在时不会覆盖。
    </p>
    <nav class="tool-options" aria-label="辅助工具类型">
      <SelectionButton v-for="item in operations" :key="item.value" :model-value="operation === item.value" :disabled="busy" @update:model-value="operation = item.value">
        {{ item.label }}
      </SelectionButton>
    </nav>
    <template v-if="operation === 'convertId'">
      <label>{{ operation === "convertId" ? "BV 或 AV 号" : "用户 UID"
      }}<input v-model="input" @keydown.stop></label>
    </template>
    <p v-else-if="operation === 'joinTime'" class="hint">
      查询当前浏览器已登录账号的入站时间。
    </p>
    <template v-else>
      <div v-if="operation !== 'mux'" class="file-field">
        <input v-model="source" readonly placeholder="选择源文件">
        <Button
          :disabled="busy"
          @click="
            pick(
              'source',
              operation === 'ccToSrt'
                ? 'cc'
                : operation === 'srtToText'
                  ? 'srt'
                  : 'audio',
            )
          "
        >
          选择文件
        </Button>
      </div>
      <template v-else>
        <div class="file-field">
          <input v-model="video" readonly placeholder="视频源"><Button
            :disabled="busy"
            @click="pick('video', 'video')"
          >
            选择视频
          </Button>
        </div>
        <div class="file-field">
          <input v-model="audio" readonly placeholder="音频源"><Button
            :disabled="busy"
            @click="pick('audio', 'audio')"
          >
            选择音频
          </Button>
        </div>
      </template>
      <div class="file-field">
        <input v-model="directory" readonly placeholder="输出目录"><Button
          :disabled="busy"
          @click="pick('directory', 'directory')"
        >
          选择目录
        </Button>
      </div>
      <SelectionButton v-if="operation === 'srtToText'" v-model="lineBreaks" :disabled="busy">
        保留换行
      </SelectionButton>
      <p v-if="operation === 'mux'" class="hint">
        混流不转码，使用 MKV 保留原始视频和音轨。
      </p>
    </template>
    <Button type="primary" :disabled="busy" @click="execute">
      {{ busy ? "处理中 / 等待文件选择…" : "开始" }}
    </Button>
    <p v-if="result" role="status" class="result">
      {{ result }}
    </p>
    <p v-if="error" role="alert" class="error">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.tool-options {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.download-tools {
  max-width: 800px;
  display: grid;
  gap: 20px;
}
h2 {
  font-size: 20px;
  font-weight: 650;
}
label {
  display: grid;
  gap: 10px;
}
input:not([type="checkbox"]) {
  padding: 11px 14px;
  border: 1px solid var(--bew-border-color);
  background: var(--bew-fill-1);
  color: inherit;
  border-radius: var(--bew-radius);
  min-width: 0;
}
.file-field {
  display: flex;
  gap: 12px;
}
.file-field > input {
  flex: 1;
}
.hint {
  color: var(--bew-text-2);
  font-size: 12px;
  line-height: 1.8;
}
.result {
  overflow-wrap: anywhere;
  padding: 16px;
  border-radius: var(--bew-radius);
  background: var(--bew-fill-1);
}
.error {
  color: var(--bew-error-color);
}
</style>
