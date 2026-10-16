<script setup lang="ts">
import './download-ui.css'

import Button from '~/components/Button.vue'

const props = defineProps<{
  modelValue: boolean
  mixed?: boolean
  disabled?: boolean
  block?: boolean
  size?: 'small' | 'medium'
}>()
const emit = defineEmits<{ (event: 'update:modelValue', value: boolean): void }>()
</script>

<template>
  <Button
    type="secondary"
    :size="size"
    :block="block"
    :disabled="disabled"
    :aria-pressed="mixed ? 'mixed' : modelValue"
    data-download-choice
    class="download-choice"
    :class="{ 'download-choice--block': block, 'download-choice--mixed': mixed }"
    :style="{
      '--b-button-color': modelValue || mixed ? 'var(--bew-theme-color-20)' : 'var(--bew-fill-1)',
      '--b-button-color-hover': modelValue || mixed ? 'var(--bew-theme-color-30)' : 'var(--bew-fill-2)',
      '--b-button-text-color': modelValue || mixed ? 'var(--bew-theme-color)' : 'var(--bew-text-1)',
    }"
    @click="!props.disabled && emit('update:modelValue', !modelValue)"
    @keydown.enter.stop
    @keydown.space.stop
  >
    <slot />
    <span v-if="mixed" class="partial-label">部分选中</span>
  </Button>
</template>

<style scoped>
.download-choice.b-button {
  flex-shrink: 0;
  height: auto;
  min-height: var(--b-button-height);
  padding-top: 8px;
  padding-bottom: 8px;
  line-height: 1.5;
  white-space: normal;
}
.download-choice.b-button--size-small {
  padding-top: 6px;
  padding-bottom: 6px;
}
.download-choice:focus-visible {
  outline: 2px solid var(--bew-theme-color);
  outline-offset: 3px;
}
.download-choice--block {
  height: auto;
  min-height: 40px;
  padding-top: 10px;
  padding-bottom: 10px;
  line-height: 1.6;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
  justify-content: flex-start;
  min-width: 0;
  flex: 1;
}
.download-choice--mixed {
  box-shadow: inset 0 0 0 1px var(--bew-theme-color-40);
}
.partial-label {
  font-size: 11px;
  margin-left: auto;
  white-space: nowrap;
}
</style>
