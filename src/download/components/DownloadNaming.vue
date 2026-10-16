<script setup lang="ts">
import { nextTick, ref } from 'vue'

import Button from '~/components/Button.vue'

import { filenamePresets, folderPresets, insertNamingVariable, namingVariables } from '../naming'
import type { DownloadOptions } from '../types'
import SelectionButton from './SelectionButton.vue'

const props = defineProps<{ modelValue: DownloadOptions }>()
const emit = defineEmits<{ (event: 'update:modelValue', value: DownloadOptions): void }>()
type Field = 'filenameTemplate' | 'folderTemplate'
const active = ref<Field>('filenameTemplate')
const filename = ref<HTMLInputElement>()
const folder = ref<HTMLInputElement>()
function update(key: keyof DownloadOptions, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
async function insert(token: string) {
  const field = active.value
  const input = field === 'filenameTemplate' ? filename.value : folder.value
  const value = props.modelValue[field]
  const result = insertNamingVariable(value, token, input?.selectionStart ?? value.length, input?.selectionEnd ?? value.length)
  update(field, result.value)
  await nextTick()
  input?.focus()
  input?.setSelectionRange(result.caret, result.caret)
}
</script>

<template>
  <div class="naming-fields bewly-download-ui">
    <div class="preset-group">
      <strong>常用文件名</strong>
      <div class="chips">
        <SelectionButton v-for="preset in filenamePresets" :key="preset.value" size="small" :model-value="modelValue.filenameTemplate === preset.value" @update:model-value="update('filenameTemplate', preset.value); active = 'filenameTemplate'">
          {{ preset.label }}
        </SelectionButton>
      </div>
    </div>
    <label class="field">文件名规则<input
      ref="filename" :value="modelValue.filenameTemplate" aria-label="文件名规则" @focus="active = 'filenameTemplate'" @keydown.stop
      @input="update('filenameTemplate', ($event.target as HTMLInputElement).value)"
    ></label>
    <div class="preset-group">
      <strong>文件夹整理</strong>
      <div class="chips">
        <SelectionButton v-for="preset in folderPresets" :key="preset.value" size="small" :model-value="modelValue.folderTemplate === preset.value" @update:model-value="update('folderTemplate', preset.value); active = 'folderTemplate'">
          {{ preset.label }}
        </SelectionButton>
      </div>
    </div>
    <label class="field">子目录规则<input
      ref="folder" :value="modelValue.folderTemplate" aria-label="子目录规则" placeholder="留空保存在下载目录；可用 / 分层" @focus="active = 'folderTemplate'"
      @keydown.stop @input="update('folderTemplate', ($event.target as HTMLInputElement).value)"
    ></label>
    <div class="chips" aria-label="变量插入位置">
      <span>点击变量加入：</span>
      <SelectionButton size="small" :model-value="active === 'filenameTemplate'" @update:model-value="active = 'filenameTemplate'">
        文件名
      </SelectionButton>
      <SelectionButton size="small" :model-value="active === 'folderTemplate'" @update:model-value="active = 'folderTemplate'">
        子目录
      </SelectionButton>
    </div>
    <div v-for="group in namingVariables" :key="group.label" class="preset-group">
      <strong>{{ group.label }}</strong>
      <div class="chips">
        <Button
          v-for="[label, token] in group.items" :key="token" type="secondary" size="small" class="variable"
          :aria-label="`插入${label} ${token}`"
          @mousedown.prevent @click="insert(token)" @keydown.enter.stop @keydown.space.stop
        >
          {{ label }} <code>{{ token }}</code>
        </Button>
      </div>
    </div>
    <SelectionButton :model-value="modelValue.createFolder" @update:model-value="update('createFolder', $event)">
      组合下载时每个视频单独建文件夹
    </SelectionButton>
    <SelectionButton :model-value="modelValue.createFolderAddIndex" @update:model-value="update('createFolderAddIndex', $event)">
      文件夹名称加序号
    </SelectionButton>
    <p class="hint">
      选择常用方案即可使用，也可以点击变量插入光标位置，或替换选中的文字。下方保存预览会随规则更新；序号建议放在最前面。
    </p>
  </div>
</template>

<style scoped>
.naming-fields {
  display: grid;
  gap: 14px;
  margin-top: 16px;
}
.preset-group {
  display: grid;
  gap: 8px;
}
.preset-group strong {
  font-size: 12px;
  color: var(--bew-text-2);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.chips > span {
  font-size: 12px;
  color: var(--bew-text-2);
}
.variable code {
  color: var(--bew-theme-color);
}
.field {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.naming-fields > label:not(.field) {
  display: flex;
  align-items: center;
  gap: 6px;
}
.field input {
  width: 100%;
  padding: 10px 12px;
  box-sizing: border-box;
  border: 1px solid var(--bew-border-color);
  border-radius: var(--bew-radius);
  background: var(--bew-fill-1);
  color: inherit;
}
input {
  accent-color: var(--bew-theme-color);
}
.hint {
  color: var(--bew-text-2);
  font-size: 12px;
  line-height: 1.8;
}
</style>
