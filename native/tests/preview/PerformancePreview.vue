<script setup lang="ts">
import { provide, ref } from 'vue'

import ForYou from '../../../src/contentScripts/views/Home/components/ForYou.vue'
import type { GridLayoutType } from '../../../src/logic'

const root = ref<HTMLElement>()
const bottom = ref<() => unknown>()
const refresh = ref<() => unknown>()
const layout = ref<GridLayoutType>('adaptive')
provide('BEWLY_APP', {
  mainAppRef: root, reachTop: ref(true), handlePageRefresh: refresh, handleReachBottom: bottom,
  haveScrollbar: async () => true, openIframeDrawer: () => {},
})
</script>
<template>
  <section ref="root" class="performance-preview">
    <header>
      <h1>推荐列表 · 加载与渲染验收</h1>
      <p>使用模拟推荐及公开封面；不访问账号或观看记录。</p>
      <div class="performance-actions">
        <Button @click="bottom?.()">加载下一批</Button>
        <Button @click="refresh?.()">刷新列表</Button>
        <Button @click="layout = layout === 'adaptive' ? 'twoColumns' : 'adaptive'">切换列表布局</Button>
      </div>
    </header>
    <ForYou :grid-layout="layout" />
  </section>
</template>
<style scoped>
.performance-preview { max-width: 1200px; margin: 36px auto 80px; }
header { margin-bottom: 30px; }
h1 { font-size: 30px; font-weight: 700; }
p { margin: 8px 0 16px; color: var(--bew-text-2); }
.performance-actions { display: flex; gap: 10px; }
</style>
