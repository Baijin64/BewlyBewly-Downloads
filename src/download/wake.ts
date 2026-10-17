import { ref } from 'vue'

import { useStorageLocal } from '~/composables/useStorageLocal'

export const helperAutoStart = useStorageLocal('bewly-native-autostart', false)

export const helperWakePrompt = ref<{ resolve: (value: boolean) => void }>()
let pending: Promise<boolean> | undefined
export function confirmHelperWake() {
  if (!pending) {
    pending = new Promise<boolean>(resolve => helperWakePrompt.value = { resolve }).finally(() => {
      pending = undefined
    })
  }
  return pending
}
export function finishHelperWake(allowed: boolean) {
  const current = helperWakePrompt.value
  helperWakePrompt.value = undefined
  current?.resolve(allowed)
}
