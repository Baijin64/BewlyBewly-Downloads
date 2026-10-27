<script setup lang="ts">
import Button from '~/components/Button.vue'
import Dialog from '~/components/Dialog.vue'

import { finishHelperWake } from '../wake'
</script>

<template>
  <Dialog
    title="允许按需启动本地下载助手？" :width="480" max-width="94vw" :show-footer="false" :confirm-on-enter="false"
    :z-index="10050" @close="finishHelperWake(false)"
  >
    <p>只有执行下载、加入队列或本地文件操作时，才会启动已安装的助手。没有进行中的任务后会自动退出，队列和文件会保留。</p>
    <p class="hint">
      以后点击这些操作时可自动唤起；可在下载设置中关闭。手动打开下载助手，可保持后台运行。
    </p>
    <div class="actions">
      <Button @click="finishHelperWake(false)">
        取消
      </Button>
      <Button type="primary" @click="finishHelperWake(true)">
        允许并继续
      </Button>
    </div>
  </Dialog>
</template>

<style scoped>
p {
  line-height: 1.8;
}
.hint {
  color: var(--bew-text-2);
  font-size: 13px;
  margin-top: 12px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}
</style>
