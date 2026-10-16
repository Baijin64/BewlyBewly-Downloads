<script setup lang="ts">
import { computed } from 'vue'

import {
  codecs,
  outputLabels,
} from '../presentation'
import { audioChoices, qualityChoices } from '../qualityChoices'
import type { AvailableAudioFormat, AvailableVideoFormat, DownloadOptions, OutputKind } from '../types'
import DownloadNaming from './DownloadNaming.vue'
import SelectionButton from './SelectionButton.vue'

const props = defineProps<{
  modelValue: DownloadOptions
  availableFormats?: AvailableVideoFormat[]
  availableAudioFormats?: AvailableAudioFormat[]
  qualityLoading?: boolean
  subtitleTracks?: { language: string, label: string }[]
}>()
const emit = defineEmits<{
  (event: 'update:modelValue', value: DownloadOptions): void
}>()
function update(key: keyof DownloadOptions, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
function toggleOutput(kind: OutputKind, checked: boolean) {
  const outputs = checked
    ? [...props.modelValue.outputs, kind]
    : props.modelValue.outputs.filter(item => item !== kind)
  emit('update:modelValue', {
    ...props.modelValue,
    outputs,
    cover: outputs.includes('cover'),
    subtitles: outputs.includes('srt'),
  })
}
const videoQualities = computed(() => {
  const choices = qualityChoices(props.availableFormats, props.modelValue.codec, props.modelValue.quality)
  return props.qualityLoading ? choices.map(item => item.value === 0 ? { ...item, label: '正在读取可用画质…' } : item) : choices
})
const audioOptions = computed(() => {
  const choices = audioChoices(props.availableAudioFormats, props.modelValue.audioQuality)
  return props.qualityLoading ? choices.map(item => item.value === 'auto' ? { ...item, label: '正在读取可用音质…' } : item) : choices
})
const languages = computed(
  () =>
    props.subtitleTracks || [
      { language: 'zh-CN', label: '中文' },
      { language: 'ai-zh', label: '中文（自动生成）' },
      { language: 'en', label: '英语' },
      { language: 'ai-en', label: '英语（自动生成）' },
    ],
)
function toggleLanguage(language: string) {
  const current = props.modelValue.subtitleLanguages
  update(
    'subtitleLanguages',
    current.includes(language)
      ? current.filter(item => item !== language)
      : [...current, language],
  )
}
</script>

<template>
  <div class="download-options bewly-download-ui">
    <fieldset>
      <legend>下载内容</legend>
      <div class="output-list">
        <SelectionButton v-for="(label, kind) in outputLabels" :key="kind" :model-value="modelValue.outputs.includes(kind)" :title="kind === 'nfo' ? '额外保存标题、UP 主、简介和原链接，方便本地媒体库整理。普通观看可不选。' : undefined" @update:model-value="toggleOutput(kind, $event)">
          {{ label }}
        </SelectionButton>
      </div>
    </fieldset>
    <p v-if="modelValue.outputs.includes('nfo')" class="hint">
      视频资料（NFO）：额外保存标题、UP 主、简介和原链接，方便本地媒体库整理。普通观看可不选。
    </p>
    <div class="format-grid">
      <label>画质<Select
        :model-value="modelValue.quality"
        :options="videoQualities"
        @update:model-value="update('quality', Number($event))"
      /></label>
      <label>视频编码<Select
        :model-value="modelValue.codec"
        :options="codecs"
        @update:model-value="update('codec', $event)"
      /></label>
      <label>音质<Select
        :model-value="modelValue.audioQuality"
        :options="audioOptions"
        @update:model-value="update('audioQuality', $event)"
      /></label>
    </div>
    <p class="hint">
      可用规格取决于当前账号和视频；所选规格不可用时会提示，不自动降级。原生音频保留源编码，Hi-Res
      / 杜比必要时使用 FLAC / MKV；MP3 是主动转码。
    </p>
    <p v-if="modelValue.audioQuality === 'auto'" class="hint">
      最高可用音质优先选择 Hi-Res 无损，其次杜比全景声，再选最高码率。每个视频、分 P 分别检查。
    </p>
    <div v-if="modelValue.outputs.includes('srt')" class="subtitle-languages">
      <span>字幕语言</span>
      <div class="output-list">
        <SelectionButton
          size="small"
          :model-value="!modelValue.subtitleLanguages.length"
          @update:model-value="update('subtitleLanguages', [])"
        >
          全部可用语言
        </SelectionButton>
        <SelectionButton
          v-for="track in languages"
          :key="track.language"
          size="small"
          :model-value="modelValue.subtitleLanguages.includes(track.language)"
          @update:model-value="toggleLanguage(track.language)"
        >
          {{ track.label }}
        </SelectionButton>
      </div>
      <p v-if="subtitleTracks && !subtitleTracks.length" class="hint">
        当前分 P 暂无可用字幕；合集里其他视频会分别检查。
      </p>
      <p v-else class="hint">
        可选择多种语言；取消全部指定语言会恢复为“全部可用语言”。默认语言以每个视频实际可用字幕为准。
      </p>
    </div>
    <details>
      <summary>文件命名与目录规则</summary>
      <DownloadNaming :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" />
    </details>
  </div>
</template>

<style scoped>
.download-options {
  display: grid;
  gap: 16px;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
legend {
  padding: 0;
  margin-bottom: 12px;
  font-weight: 600;
}
.output-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.format-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.format-grid > label,
.field {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.hint {
  color: var(--bew-text-2);
  font-size: 12px;
  line-height: 1.8;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
.subtitle-languages {
  display: grid;
  gap: 10px;
}
.naming-fields {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}
input:not([type="checkbox"]) {
  padding: 10px 12px;
  border: 1px solid var(--bew-border-color);
  border-radius: var(--bew-radius);
  background: var(--bew-fill-1);
  width: 100%;
  color: inherit;
  box-sizing: border-box;
}
input {
  accent-color: var(--bew-theme-color);
}
@media (max-width: 600px) {
  .format-grid {
    grid-template-columns: 1fr;
  }
}
</style>
