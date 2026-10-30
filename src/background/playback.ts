import browser from 'webextension-polyfill'

import type {
  PlaybackIdentity,
  PlaybackSample,
  PlaybackStream,
} from '~/playback/engine'
import { PlaybackOptimizer, trustedMedia } from '~/playback/engine'

import { biliApi } from './downloadResolver'

const settingKey = 'bewly-playback-settings'
const sessionKey = 'bewly-playback-session'
const baseOrigins = [
  'https://*.bilivideo.com/*',
  'https://*.bilivideo.cn/*',
  'https://*.bilivideo.net/*',
  'https://upos-hz-mirrorakam.akamaized.net/*',
]
const mediaPatterns = [...baseOrigins.slice(0, 3), 'https://*.akamaized.net/*']
const firstRule = 7600000
let ruleSequence = firstRule
let enabled = false
let modeRevision = 0
let probeController = new AbortController()
const tabRevisions = new Map<number, object>()
let observersInstalled = false
let startup: Promise<void> = Promise.resolve()
let persistTimer: ReturnType<typeof setTimeout> | undefined
const ruleIds = new Map<number, number[]>()
const apiIdentity = new Map<number, PlaybackIdentity>()
const preparing = new Map<number, Promise<void>>()
const metadataRetry = new Map<number, { until: number, error: string }>()
const escapeRegex = (text: string) => text.replace(/[.*+?^$()|[\]\\]/g, '\\$&')

function changeMode(value: boolean) {
  modeRevision++
  enabled = value
  probeController.abort()
  probeController = new AbortController()
  preparing.clear()
  metadataRetry.clear()
}
function operation(tab: number) {
  const mode = modeRevision
  const revision = tabRevisions.get(tab) || {}
  tabRevisions.set(tab, revision)
  return () =>
    enabled && mode === modeRevision && revision === tabRevisions.get(tab)
}
async function removeRuleIds(tab: number, ids: number[]) {
  if (ids.length) {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ids,
    })
  }
  const remaining = (ruleIds.get(tab) || []).filter(id => !ids.includes(id))
  if (remaining.length)
    ruleIds.set(tab, remaining)
  else ruleIds.delete(tab)
}
async function clearRules(tab: number) {
  await removeRuleIds(tab, [...(ruleIds.get(tab) || [])])
}
async function streams(identity: PlaybackIdentity): Promise<PlaybackStream[]> {
  const data = await biliApi('/x/player/playurl', {
    bvid: identity.bvid,
    cid: String(identity.cid),
    qn: String(identity.quality || 127),
    fnval: '4048',
    fnver: '0',
    fourk: '1',
  })
  const map = (value: any, kind: 'video' | 'audio'): PlaybackStream => ({
    kind,
    id: value.id,
    codec: value.codecid || 0,
    codecs: value.codecs || '',
    bandwidth: value.bandwidth || 0,
    urls: [
      value.baseUrl || value.base_url,
      ...(value.backupUrl || value.backup_url || []),
    ].filter(Boolean),
  })
  return [
    ...(data.dash?.video || []).map((value: any) => map(value, 'video')),
    ...[
      ...(data.dash?.audio || []),
      ...(data.dash?.dolby?.audio || []),
      ...(data.dash?.flac?.audio ? [data.dash.flac.audio] : []),
    ].map(value => map(value, 'audio')),
  ]
}
async function probe(value: string) {
  const revision = modeRevision
  const signal = probeController.signal
  const controller = new AbortController()
  const abort = () => controller.abort()
  const check = () => {
    if (!enabled || revision !== modeRevision)
      throw new Error('播放优化操作已取消')
  }
  check()
  const url = trustedMedia(value)
  const id = ++ruleSequence
  const regexFilter = `^${escapeRegex(url)}$`
  let started = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    signal.addEventListener('abort', abort, { once: true })
    await browser.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id,
          priority: 1000,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              {
                header: 'Referer',
                operation: 'set',
                value: 'https://www.bilibili.com/',
              },
            ],
          },
          condition: {
            regexFilter,
            tabIds: [-1],
            initiatorDomains: [browser.runtime.id],
            resourceTypes: ['xmlhttprequest'],
          },
        },
      ],
    })
    check()
    started = performance.now()
    timeout = setTimeout(abort, 4000)
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-131071' },
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    })
    check()
    if (!response.ok || !response.body)
      throw new Error('线路探测未成功')
    reader = response.body.getReader()
    let bytes = 0
    while (bytes < 131072) {
      const chunk = await reader.read()
      if (chunk.done)
        break
      bytes += chunk.value.byteLength
    }
    if (!bytes)
      throw new Error('线路没有返回媒体数据')
    const elapsed = Math.max(1, performance.now() - started)
    return { url, bytesPerSecond: (bytes / elapsed) * 1000, elapsed }
  }
  finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    await reader?.cancel().catch(() => {})
    await browser.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: [id] })
      .catch(() => {})
  }
}
const optimizer = new PlaybackOptimizer({
  now: Date.now,
  api: streams,
  allowed: url =>
    browser.permissions.contains({ origins: [`${new URL(url).origin}/*`] }),
  probe,
  async redirect(tab, source, target) {
    const live = operation(tab)
    if (!live())
      throw new Error('播放优化操作已取消')
    source = trustedMedia(source)
    target = trustedMedia(target)
    const url = new URL(source)
    const id = ++ruleSequence
    // The pathname identifies this exact media stream. Only its authentication
    // query may change when the user explicitly reloads the player.
    const regexFilter = `^${escapeRegex(url.origin + url.pathname)}(?:\\?.*)?$`
    const support = await browser.declarativeNetRequest.isRegexSupported({
      regex: regexFilter,
    })
    if (!live())
      throw new Error('播放优化操作已取消')
    if (!support.isSupported)
      throw new Error('当前媒体地址不支持安全重定向')
    await browser.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id,
          priority: 900,
          action: { type: 'redirect', redirect: { url: target } },
          condition: {
            regexFilter,
            tabIds: [tab],
            initiatorDomains: ['bilibili.com'],
            resourceTypes: ['media', 'xmlhttprequest', 'other'],
            requestMethods: ['get', 'head'],
          },
        },
      ],
    })
    if (!live()) {
      await removeRuleIds(tab, [id])
      throw new Error('播放优化操作已取消')
    }
    ruleIds.set(tab, [...(ruleIds.get(tab) || []), id])
    return () => removeRuleIds(tab, [id])
  },
  clearRules,
  persist() {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(
      () =>
        browser.storage.session
          .set({
            [sessionKey]: {
              states: optimizer.snapshot(),
              rules: [...ruleIds.entries()],
              identities: [...apiIdentity.entries()],
            },
          })
          .catch(() => {}),
      150,
    )
  },
})
function readSetting(value: unknown) {
  try {
    return (
      (typeof value === 'string' ? JSON.parse(value) : value)?.enabled === true
    )
  }
  catch {
    return false
  }
}
async function clearAll(revision = modeRevision) {
  for (const tab of [...optimizer.states.keys()]) {
    if (revision !== modeRevision)
      return
    await optimizer.clear(tab)
  }
  const rules = await browser.declarativeNetRequest.getSessionRules()
  if (revision !== modeRevision)
    return
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules
      .filter(rule => rule.id >= firstRule)
      .map(rule => rule.id),
  })
  if (revision !== modeRevision)
    return
  ruleIds.clear()
  apiIdentity.clear()
}
async function prepare(
  tab: number,
  bvid: string,
  page: number,
  live: () => boolean,
) {
  if (preparing.has(tab))
    return preparing.get(tab)
  const retry = metadataRetry.get(tab)
  if (retry && retry.until > Date.now())
    throw new Error(retry.error)
  const pending: Promise<void> = (async () => {
    let identity = apiIdentity.get(tab)
    if (!identity || identity.bvid !== bvid) {
      let video: any
      try {
        video = await biliApi('/x/web-interface/wbi/view', { bvid })
      }
      catch {
        video = await biliApi('/x/web-interface/view', { bvid })
      }
      if (!live())
        return
      const part = video.pages?.find((item: any) => item.page === page)
      if (!part)
        throw new Error('没有找到当前分 P')
      identity = { bvid, cid: part.cid, quality: 127 }
      apiIdentity.set(tab, identity)
    }
    if (live())
      await optimizer.prepare(tab, identity)
  })()
    .then(() => {
      if (live())
        metadataRetry.delete(tab)
    })
    .catch((error) => {
      if (!live())
        return
      metadataRetry.set(tab, {
        until: Date.now() + 30000,
        error: error.message,
      })
      throw error
    })
    .finally(() => {
      if (preparing.get(tab) === pending)
        preparing.delete(tab)
    })
  preparing.set(tab, pending)
  return pending
}
function installObservers() {
  if (observersInstalled || !browser.webRequest?.onBeforeRequest)
    return
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      startup
        .then(() => {
          if (enabled && details.tabId >= 0)
            optimizer.observe(details.tabId, details.url)
        })
        .catch(() => {})
    },
    { urls: mediaPatterns },
  )
  browser.webRequest.onCompleted.addListener(
    (details) => {
      startup
        .then(() => {
          if (!enabled || details.tabId < 0)
            return
          if (details.statusCode >= 400)
            optimizer.failed(details.tabId, details.url).catch(() => {})
        })
        .catch(() => {})
    },
    { urls: mediaPatterns },
  )
  browser.webRequest.onErrorOccurred.addListener(
    (details) => {
      startup
        .then(() => {
          if (enabled && details.tabId >= 0)
            optimizer.failed(details.tabId, details.url).catch(() => {})
        })
        .catch(() => {})
    },
    { urls: mediaPatterns },
  )
  browser.webRequest.onCompleted.addListener(
    (details) => {
      startup
        .then(() => {
          if (!enabled || details.tabId < 0)
            return
          const url = new URL(details.url)
          const bvid = url.searchParams.get('bvid')
          const cid = Number(url.searchParams.get('cid'))
          if (
            !bvid
            || !/^BV[0-9A-Za-z]{10}$/.test(bvid)
            || !Number.isSafeInteger(cid)
            || cid <= 0
          ) {
            return
          }
          const identity = {
            bvid,
            cid,
            quality: Number(url.searchParams.get('qn')) || 127,
          }
          apiIdentity.set(details.tabId, identity)
          optimizer.prepare(details.tabId, identity).catch(() => {})
        })
        .catch(() => {})
    },
    {
      urls: [
        'https://api.bilibili.com/x/player/playurl*',
        'https://api.bilibili.com/x/player/wbi/playurl*',
      ],
    },
  )
  observersInstalled = true
}

export function setupPlaybackMessages() {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'bewly-playback-expiry')
      return
    for (const [tab, state] of optimizer.states) {
      if (state.expires && state.expires <= Date.now())
        optimizer.clear(tab).catch(() => {})
    }
  })
  const ready = (async () => {
    enabled = readSetting(
      (await browser.storage.local.get(settingKey))[settingKey],
    )
    const saved = (await browser.storage.session.get(sessionKey))[sessionKey]
    if (saved && enabled) {
      optimizer.restore(saved.states)
      for (const [tab, ids] of saved.rules || []) {
        if (optimizer.states.has(tab))
          ruleIds.set(tab, ids)
      }
      for (const [tab, identity] of saved.identities || [])
        apiIdentity.set(tab, identity)
    }
    const rules = await browser.declarativeNetRequest.getSessionRules()
    ruleSequence = Math.max(firstRule, ...rules.map(rule => rule.id))
    if (!enabled) {
      await clearAll()
    }
    else {
      const tracked = new Set(Array.from(ruleIds.values()).flat())
      await browser.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rules
          .filter(rule => rule.id >= firstRule && !tracked.has(rule.id))
          .map(rule => rule.id),
      })
    }
    if (await browser.permissions.contains({ permissions: ['webRequest'] }))
      installObservers()
  })()
  startup = ready
  // A previously granted webRequest listener must register during worker startup.
  // Event callbacks await restoration before handling their first request.
  try {
    installObservers()
  }
  catch {
    observersInstalled = false
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[settingKey])
      return
    const next = readSetting(changes[settingKey].newValue)
    if (next !== enabled)
      changeMode(next)
    if (!enabled)
      clearAll().catch(() => {})
  })
  browser.tabs.onRemoved.addListener((tab) => {
    tabRevisions.delete(tab)
    preparing.delete(tab)
    metadataRetry.delete(tab)
    apiIdentity.delete(tab)
    optimizer.clear(tab).catch(() => {})
  })
  browser.tabs.onUpdated.addListener((tab, change) => {
    if (change.url) {
      tabRevisions.set(tab, {})
      preparing.delete(tab)
      metadataRetry.delete(tab)
      apiIdentity.delete(tab)
      optimizer.clear(tab).catch(() => {})
    }
  })
  browser.permissions.onRemoved.addListener(() => {
    changeMode(false)
    clearAll().catch(() => {})
    browser.storage.local
      .set({ [settingKey]: JSON.stringify({ enabled: false }) })
      .catch(() => {})
  })
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.bewlyPlayback !== true)
      return undefined
    const url = new URL(sender.url || 'https://invalid.local')
    if (
      sender.id !== browser.runtime.id
      || url.protocol !== 'https:'
      || !url.hostname.endsWith('.bilibili.com')
    ) {
      return Promise.resolve({ ok: false, error: '播放优化来源无效' })
    }
    const tab = sender.tab?.id
    if (tab === undefined)
      return Promise.resolve({ ok: false, error: '未找到当前标签页' })
    // Permission requests must remain directly in this user gesture, before
    // awaiting startup, network operations or worker-state reconstruction.
    if (message.method === 'enable') {
      const origins = Array.isArray(message.origins)
        ? message.origins
          .slice(0, 10)
          .map(
            (origin: string) =>
                `${new URL(trustedMedia(origin.replace(/\/\*$/, '/'))).origin}/*`,
          )
        : baseOrigins
      return browser.permissions
        .request({ permissions: ['webRequest'], origins })
        .then(async (granted) => {
          if (!granted)
            throw new Error('未获得媒体线路权限，已保留原播放器')
          await ready
          installObservers()
          changeMode(true)
          optimizer.state(tab).attempts = 0
          optimizer.state(tab).lastAttempt = 0
          metadataRetry.delete(tab)
          await browser.alarms.create('bewly-playback-expiry', {
            periodInMinutes: 1,
          })
          await browser.storage.local.set({
            [settingKey]: JSON.stringify({ enabled: true }),
          })
          return { ok: true, result: { enabled: true } }
        })
        .catch(error => ({ ok: false, error: error.message }))
    }
    return (async () => {
      await ready
      if (message.method === 'disable') {
        changeMode(false)
        const revision = modeRevision
        await clearAll(revision)
        if (revision !== modeRevision)
          return { enabled }
        await browser.alarms.clear('bewly-playback-expiry')
        await browser.storage.local.set({
          [settingKey]: JSON.stringify({ enabled: false }),
        })
        return { enabled }
      }
      if (message.method === 'status')
        return { enabled, diagnostic: optimizer.diagnostic(tab) }
      if (message.method !== 'sample' || !enabled)
        return { enabled }
      const sample = message.sample as PlaybackSample
      if (
        !sample
        || !/^BV[0-9A-Za-z]{10}$/.test(sample.bvid)
        || !Number.isInteger(sample.page)
        || sample.page < 1
        || !Number.isFinite(sample.buffer)
        || !Number.isFinite(sample.waitingSeconds)
        || !Number.isFinite(sample.droppedRatio)
      ) {
        throw new Error('无效播放诊断')
      }
      if (sample.playing && sample.visible && !sample.seeking) {
        const live = operation(tab)
        await prepare(tab, sample.bvid, sample.page, live)
        if (!live())
          return { enabled }
        const diagnostic = await optimizer.optimize(tab, sample)
        return live() ? { enabled, diagnostic } : { enabled }
      }
      return { enabled, diagnostic: optimizer.diagnostic(tab) }
    })().then(
      result => ({ ok: true, result }),
      error => ({ ok: false, error: error.message }),
    )
  })
}
