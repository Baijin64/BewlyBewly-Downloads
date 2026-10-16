<script setup lang="ts">
import { onKeyStroke } from '@vueuse/core'
import type { Ref } from 'vue'
import { useToast } from 'vue-toastification'

import { useBewlyApp } from '~/composables/useAppProvider'
import { FilterType, useFilter } from '~/composables/useFilter'
import { LanguageType } from '~/enums/appEnums'
import { abortError } from '~/loading/broker'
import type { RecommendationCard } from '~/loading/cards'
import { appCard, webCard } from '~/loading/cards'
import { loadingRequest } from '~/loading/client'
import { FeedLoader } from '~/loading/feed'
import type { GridLayoutType } from '~/logic'
import { accessKey, settings } from '~/logic'
import type { AppForYouResult, Item as AppVideoItem } from '~/models/video/appForYou'
import { Type as ThreePointV2Type } from '~/models/video/appForYou'
import type { forYouResult } from '~/models/video/forYou'
import { TVAppKey } from '~/utils/authProvider'

const props = defineProps<{
  gridLayout: GridLayoutType
}>()

const emit = defineEmits<{
  (e: 'beforeLoading'): void
  (e: 'afterLoading'): void
}>()

const filterFunc = useFilter(
  ['is_followed'],
  [FilterType.duration, FilterType.viewCount, FilterType.title, FilterType.user, FilterType.user],
  [['duration'], ['stat', 'view'], ['title'], ['owner', 'name'], ['owner', 'mid']],
)
const appFilterFunc = useFilter(
  ['bottom_rcmd_reason'],
  [FilterType.filterOutVerticalVideos, FilterType.duration, FilterType.viewCountStr, FilterType.title, FilterType.user, FilterType.user],
  [['uri'], ['player_args', 'duration'], ['cover_left_text_1'], ['title'], ['mask', 'avatar', 'text'], ['mask', 'avatar', 'up_id']],
)

const gridClass = computed((): string => {
  if (props.gridLayout === 'adaptive')
    return 'grid-adaptive'
  if (props.gridLayout === 'twoColumns')
    return 'grid-two-columns'
  return 'grid-one-column'
})

const videoList = shallowRef<RecommendationCard[]>([])
const appVideoList = shallowRef<RecommendationCard[]>([])
const isLoading = ref<boolean>(false)
const needToLoginFirst = ref<boolean>(false)
const containerRef = ref<HTMLElement>() as Ref<HTMLElement>
const noMoreContent = ref<boolean>(false)
const { handleReachBottom, handlePageRefresh, haveScrollbar } = useBewlyApp()
const activatedAppVideo = ref<AppVideoItem | null>()
const videoCardRef = ref(null)
const showDislikeDialog = ref<boolean>(false)
const selectedDislikeReason = ref<number>(1)
const PAGE_SIZE = 30

onKeyStroke((e: KeyboardEvent) => {
  if (showDislikeDialog.value) {
    const dislikeReasons = activatedAppVideo.value?.three_point_v2?.find(option => option.type === ThreePointV2Type.Dislike)?.reasons || []

    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault()
      dislikeReasons.forEach((reason) => {
        if (dislikeReasons[Number(e.key) - 1] && reason.id === dislikeReasons[Number(e.key) - 1].id)
          selectedDislikeReason.value = reason.id
      })
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const currentIndex = dislikeReasons.findIndex(reason => selectedDislikeReason.value === reason.id)
      if (currentIndex > 0)
        selectedDislikeReason.value = dislikeReasons[currentIndex - 1].id
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const currentIndex = dislikeReasons.findIndex(reason => selectedDislikeReason.value === reason.id)
      if (currentIndex < dislikeReasons.length - 1)
        selectedDislikeReason.value = dislikeReasons[currentIndex + 1].id
    }
  }
})

const toast = useToast()
let activeMode: 'web' | 'app' = 'web'
let placeholderTarget = 0
let sequence = 0
let initialized = false
let mounted = false
let initialTimer: ReturnType<typeof setTimeout> | undefined
const loader = new FeedLoader<RecommendationCard>({
  key: item => item.uniqueId,
  changed: () => {
    const list = activeMode === 'web' ? videoList : appVideoList
    list.value = [...loader.items, ...Array.from({ length: loader.loading ? Math.max(0, placeholderTarget - loader.items.length) : 0 }, (_, index) => ({ uniqueId: `pending-${sequence}-${index}` }))]
    noMoreContent.value = loader.done
    if (isLoading.value !== loader.loading) {
      isLoading.value = loader.loading
      if (loader.loading)
        emit('beforeLoading')
      else emit('afterLoading')
    }
  },
  error: () => toast.error('推荐加载失败，可点击刷新重试。'),
  page: async (cursor, signal) => {
    const mode = activeMode
    if (mode === 'web') {
      const response = await loadingRequest<forYouResult>('getRecommendVideos', { fresh_idx: cursor, ps: PAGE_SIZE }, signal)
      if (signal.aborted)
        throw abortError()
      if (response.code === 62011) {
        needToLoginFirst.value = true
        return { items: [], next: cursor, done: true }
      }
      if (response.code !== 0)
        throw new Error('推荐加载失败')
      const raw = response.data?.item || []
      return { items: raw.filter(item => !filterFunc.value || filterFunc.value(item)).map(webCard), next: cursor + 1, done: raw.length === 0 }
    }
    const locale = [LanguageType.Mandarin_TW, LanguageType.Cantonese].includes(settings.value.language as LanguageType) ? 'zh-Hant_TW' : 'zh-Hans_CN'
    const response = await loadingRequest<AppForYouResult>('getAppRecommendVideos', {
      access_key: accessKey.value,
      s_locale: locale,
      c_locate: locale,
      appkey: TVAppKey.appkey,
      idx: cursor,
    }, signal)
    if (signal.aborted)
      throw abortError()
    if (response.code === 62011) {
      needToLoginFirst.value = true
      return { items: [], next: cursor, done: true }
    }
    if (response.code !== 0)
      throw new Error('推荐加载失败')
    const raw = response.data?.items || []
    return {
      items: raw.filter(item => !item.card_type.includes('banner') && item.card_type !== 'cm_v1' && (!appFilterFunc.value || appFilterFunc.value(item))).map(appCard),
      next: raw.at(-1)?.idx ?? cursor,
      done: raw.length === 0,
    }
  },
})

function initData() {
  clearTimeout(initialTimer)
  initialTimer = undefined
  loader.reset()
  activeMode = settings.value.recommendationMode || 'web'
  videoList.value = []
  appVideoList.value = []
  needToLoginFirst.value = false
  initialized = true
  if (document.hidden) {
    loader.pause()
    return Promise.resolve()
  }
  return getData()
}
function getData() {
  if (!loader.loading) {
    sequence++
    const filtered = activeMode === 'web' ? filterFunc.value : appFilterFunc.value
    placeholderTarget = filtered && loader.items.length >= PAGE_SIZE ? loader.items.length : Math.max(PAGE_SIZE, loader.items.length + PAGE_SIZE)
  }
  return loader.load({ minPages: activeMode === 'app' ? 3 : 1, maxPages: 3, target: PAGE_SIZE, needsMore: async () => !await haveScrollbar() })
}
function initPageAction() {
  handleReachBottom.value = getData
  handlePageRefresh.value = initData
}
function visibilityChanged() {
  if (document.hidden) {
    loader.pause()
  }
  else if (mounted) {
    loader.resume()
    if (!loader.items.length && initialized)
      getData()
  }
}
watch(() => settings.value.recommendationMode, () => {
  if (mounted)
    initData()
})
onMounted(() => {
  mounted = true
  // Keep the existing initial settings-read delay, but own and cancel the timer.
  initialTimer = setTimeout(initData, 200)
  initPageAction()
  document.addEventListener('visibilitychange', visibilityChanged)
})
onActivated(() => {
  mounted = true
  loader.resume()
  initPageAction()
  if (!initialTimer) {
    if (!initialized || activeMode !== settings.value.recommendationMode)
      initData()
    else if (!loader.items.length)
      getData()
  }
})
onDeactivated(() => {
  mounted = false
  clearTimeout(initialTimer)
  initialTimer = undefined
  loader.pause()
})
onBeforeUnmount(() => {
  mounted = false
  clearTimeout(initialTimer)
  loader.pause()
  document.removeEventListener('visibilitychange', visibilityChanged)
})

function jumpToLoginPage() {
  location.href = 'https://passport.bilibili.com/login'
}

defineExpose({ initData })
</script>

<template>
  <div>
    <Empty v-if="needToLoginFirst" mt-6 :description="$t('common.please_log_in_first')">
      <Button type="primary" @click="jumpToLoginPage()">
        {{ $t('common.login') }}
      </Button>
    </Empty>

    <div
      v-else
      ref="containerRef"
      m="b-0 t-0" relative w-full h-full
      :class="gridClass"
    >
      <template v-if="settings.recommendationMode === 'web'">
        <VideoCard
          v-for="(video, index) in videoList"
          :key="video.uniqueId"
          v-memo="[video, gridLayout]"
          :cover-loading="index < 10 ? 'eager' : 'lazy'"
          :skeleton="!video.video"
          type="rcmd"
          :video="video.video"
          show-preview
          :horizontal="gridLayout !== 'adaptive'"
          more-btn
        />
      </template>
      <template v-else>
        <VideoCard
          v-for="(video, index) in appVideoList"
          :key="video.uniqueId"
          ref="videoCardRef"
          v-memo="[video, gridLayout]"
          :cover-loading="index < 10 ? 'eager' : 'lazy'"
          :skeleton="!video.video"
          type="appRcmd"
          :video="video.video"
          show-preview
          :horizontal="gridLayout !== 'adaptive'"
          more-btn
        />
        <!-- :more-options="video.three_point_v2" -->
      </template>
    </div>

    <Loading v-show="isLoading" />
    <!-- no more content -->
    <Empty v-if="noMoreContent" class="pb-4" :description="$t('common.no_more_content')" />
  </div>
</template>

<style lang="scss" scoped>
.grid-adaptive {
  --uno: "grid 2xl:cols-5 xl:cols-4 lg:cols-3 md:cols-2 sm:cols-1 cols-1 gap-5";
}

.grid-two-columns {
  --uno: "grid cols-1 xl:cols-2 gap-4";
}

.grid-one-column {
  --uno: "grid cols-1 gap-4";
}
</style>
