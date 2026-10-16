<script setup lang="ts">
import '~/download/components/download-ui.css'

import { onBeforeUnmount, onMounted, ref } from 'vue'

import Radio from '~/components/Radio.vue'
import SettingsItem from '~/components/Settings/components/SettingsItem.vue'

import { playbackRequest } from './client'

const enabled = ref(false)
const busy = ref(false)
const loading = ref(true)
const error = ref('')
let disposed = false
async function change(value: boolean) {
  if (busy.value || loading.value)
    return
  busy.value = true
  error.value = ''
  try {
    const result = await playbackRequest(value ? 'enable' : 'disable')
    if (disposed)
      return
    enabled.value = result.enabled
    window.dispatchEvent(new Event('bewly-playback-settings-changed'))
  }
  catch (err) {
    if (!disposed)
      error.value = String((err as Error).message)
  }
  finally {
    if (!disposed)
      busy.value = false
  }
}
onMounted(async () => {
  try {
    const result = await playbackRequest('status')
    if (!disposed)
      enabled.value = result.enabled
  }
  catch (err) {
    if (!disposed)
      error.value = String((err as Error).message)
  }
  finally {
    if (!disposed)
      loading.value = false
  }
})
onBeforeUnmount(() => {
  disposed = true
})
</script>

<template>
  <div class="playback-settings bewly-download-ui">
    <SettingsItem title="自动线路优化" desc="持续卡顿时比较同规格的官方备用线路，保留画质、编码和音轨。需要重载时提示，由你决定。">
      <Radio :model-value="enabled" aria-label="自动线路优化" :disabled="busy || loading" @update:model-value="change" />
    </SettingsItem>
    <p class="hint">
      开启时浏览器会请求媒体域名权限。只作用于当前视频标签页；关闭后清除临时切换。网络线路本身较慢或解码性能不足时，改善可能有限。
    </p>
    <p v-if="busy" class="hint" role="status">
      正在更新线路优化设置…
    </p>
    <p v-if="error" role="alert" class="error">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.playback-settings {
  display: grid;
  gap: 14px;
  line-height: 1.8;
}
.hint {
  color: var(--bew-text-2);
  font-size: 12px;
}
.error {
  color: var(--bew-error-color);
}
</style>
