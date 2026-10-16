export interface PlaybackSample {
  bvid: string
  page: number
  buffer: number
  waitingSeconds: number
  playing: boolean
  seeking: boolean
  visible: boolean
  droppedRatio: number
}
export interface PlaybackStream {
  kind: 'video' | 'audio'
  id: number
  codec: number
  codecs: string
  bandwidth: number
  urls: string[]
}
export interface PlaybackIdentity {
  bvid: string
  cid: number
  quality: number
}
export interface PlaybackDiagnostic {
  state: 'idle' | 'network' | 'decode' | 'optimized' | 'unavailable' | 'failed'
  message: string
  reloadSuggested: boolean
  hosts: string[]
  missingOrigins: string[]
}
interface PlaybackState {
  identity?: PlaybackIdentity
  streams: PlaybackStream[]
  observed: string[]
  redirects: { source: string, target: string }[]
  lastAttempt: number
  attempts: number
  expires: number
  diagnostic: PlaybackDiagnostic
}
export interface ProbeResult {
  url: string
  bytesPerSecond: number
  elapsed: number
}
export function trustedMedia(value: string) {
  const url = new URL(value.startsWith('//') ? `https:${value}` : value)
  if (url.protocol === 'http:')
    url.protocol = 'https:'
  const host = url.hostname
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || !(
      ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net'].some(
        domain => host === domain || host.endsWith(`.${domain}`),
      ) || /^upos-[a-z0-9-]+\.akamaized\.net$/.test(host)
    )
  ) {
    throw new Error('该地址不是支持的官方媒体线路')
  }
  url.hash = ''
  return url.href
}
function resource(value: string) {
  const url = new URL(value)
  return url.pathname
}
export function playbackCause(sample: PlaybackSample) {
  if (!sample.visible || !sample.playing || sample.seeking)
    return 'idle'
  if (sample.buffer >= 5 && sample.droppedRatio >= 0.1)
    return 'decode'
  if (sample.buffer < 1 && sample.waitingSeconds >= 5)
    return 'network'
  return 'idle'
}
export function fasterProbe(probes: ProbeResult[], current: string) {
  const best = [...probes].sort(
    (a, b) => b.bytesPerSecond - a.bytesPerSecond,
  )[0]
  const baseline = probes.find(probe => probe.url === current)
  return best
    && best.url !== current
    && (!baseline || best.bytesPerSecond > baseline.bytesPerSecond * 1.25)
    ? best
    : undefined
}
function idle(): PlaybackDiagnostic {
  return {
    state: 'idle',
    message: '等待播放，保留原画质与音轨。',
    reloadSuggested: false,
    hosts: [],
    missingOrigins: [],
  }
}

export class PlaybackOptimizer {
  states = new Map<number, PlaybackState>()
  busy = new Set<number>()
  constructor(
    private io: {
      now: () => number
      api: (identity: PlaybackIdentity) => Promise<PlaybackStream[]>
      allowed: (url: string) => Promise<boolean>
      probe: (url: string) => Promise<ProbeResult>
      redirect: (
        tab: number,
        source: string,
        target: string,
      ) => Promise<void | (() => Promise<void>)>
      clearRules: (tab: number) => Promise<void>
      persist: () => void
    },
  ) {}

  state(tab: number) {
    if (!this.states.has(tab)) {
      this.states.set(tab, {
        streams: [],
        observed: [],
        redirects: [],
        lastAttempt: 0,
        attempts: 0,
        expires: 0,
        diagnostic: idle(),
      })
    }
    return this.states.get(tab)!
  }

  snapshot() {
    return [...this.states.entries()]
  }

  restore(value: unknown) {
    if (Array.isArray(value)) {
      for (const [tab, state] of value) {
        if (
          Number.isInteger(tab)
          && state?.identity
          && state.expires > this.io.now()
        ) {
          this.states.set(tab, state)
        }
      }
    }
  }

  async clear(tab: number) {
    this.states.delete(tab)
    await this.io.clearRules(tab)
    this.io.persist()
  }

  observe(tab: number, value: string) {
    let url: string
    try {
      url = trustedMedia(value)
    }
    catch {
      return
    }
    const state = this.state(tab)
    state.observed = [
      ...state.observed.filter(item => resource(item) !== resource(url)),
      url,
    ].slice(-40)
  }

  async prepare(tab: number, identity: PlaybackIdentity) {
    const current = this.state(tab)
    if (
      current.identity?.bvid === identity.bvid
      && current.identity.cid === identity.cid
      && current.identity.quality === identity.quality
      && current.expires > this.io.now()
      && current.streams.length > 0
    ) {
      return
    }
    const sameContent
      = current.identity?.bvid === identity.bvid
      && current.identity.cid === identity.cid
      && current.expires > this.io.now()
    if (!sameContent)
      await this.io.clearRules(tab)
    if (this.states.get(tab) !== current)
      return
    const state: PlaybackState = {
      ...current,
      identity,
      streams: [],
      redirects: sameContent ? [...current.redirects] : [],
      attempts: sameContent ? current.attempts : 0,
      lastAttempt: sameContent ? current.lastAttempt : 0,
      diagnostic:
        sameContent && current.redirects.length ? current.diagnostic : idle(),
      expires:
        sameContent && current.redirects.length
          ? Math.min(current.expires, this.io.now() + 10 * 60000)
          : this.io.now() + 10 * 60000,
    }
    this.states.set(tab, state)
    const streams = await this.io.api(identity)
    if (this.states.get(tab) !== state)
      return
    state.streams = streams
      .map(stream => ({
        ...stream,
        urls: [
          ...new Set(
            stream.urls.flatMap((url) => {
              try {
                return [trustedMedia(url)]
              }
              catch {
                return []
              }
            }),
          ),
        ].slice(0, 8),
      }))
      .filter(stream => stream.urls.length)
    if (
      sameContent
      && state.redirects.some((rule) => {
        const original = current.streams.find(stream =>
          stream.urls.some(url => resource(url) === resource(rule.source)),
        )
        return (
          !original
          || !state.streams.some(
            stream =>
              stream.kind === original.kind
              && stream.id === original.id
              && stream.codec === original.codec
              && stream.urls.some(
                url =>
                  new URL(url).origin === new URL(rule.target).origin
                    && resource(url) === resource(rule.target),
              ),
          )
        )
      })
    ) {
      await this.io.clearRules(tab)
      state.redirects = []
    }
    for (const stream of state.streams) {
      for (const value of stream.urls) {
        const deadline = Number(new URL(value).searchParams.get('deadline'))
        if (deadline > 0)
          state.expires = Math.min(state.expires, deadline * 1000 - 10000)
      }
    }
    this.io.persist()
  }

  diagnostic(tab: number) {
    return this.state(tab).diagnostic
  }

  async failed(tab: number, url: string) {
    const state = this.states.get(tab)
    if (
      !state?.redirects.some(
        rule =>
          new URL(rule.target).host === new URL(url).host
            && resource(rule.target) === resource(url),
      )
    ) {
      return
    }
    await this.io.clearRules(tab)
    state.redirects = []
    state.diagnostic = {
      ...idle(),
      state: 'failed',
      message:
        '备用线路请求失败，已撤销切换。可手动重载播放器，或下载后本地播放。',
      reloadSuggested: true,
    }
    this.io.persist()
  }

  async optimize(tab: number, sample: PlaybackSample) {
    const state = this.state(tab)
    const cause = playbackCause(sample)
    if (cause === 'decode') {
      state.diagnostic = {
        ...idle(),
        state: 'decode',
        message:
          '缓冲充足但解码丢帧较多，切换线路帮助有限；可手动选择 AVC 或降低画质。',
      }
      return state.diagnostic
    }
    if (cause !== 'network') {
      if (sample.buffer >= 1)
        state.diagnostic.reloadSuggested = false
      return state.diagnostic
    }
    if (state.redirects.length) {
      state.diagnostic.reloadSuggested = sample.waitingSeconds >= 10
      return state.diagnostic
    }
    if (
      this.busy.has(tab)
      || (state.lastAttempt && this.io.now() - state.lastAttempt < 60000)
      || state.attempts >= 2
    ) {
      return state.diagnostic
    }
    if (
      !state.identity
      || !state.streams.length
      || state.identity.bvid !== sample.bvid
      || state.expires <= this.io.now()
    ) {
      state.diagnostic = {
        ...idle(),
        state: 'unavailable',
        message: '尚未匹配当前视频的有效媒体信息，保持原播放器线路。',
      }
      return state.diagnostic
    }
    this.busy.add(tab)
    state.lastAttempt = this.io.now()
    state.attempts++
    state.diagnostic = {
      ...idle(),
      state: 'network',
      message: '正在比较当前规格的官方备用线路…',
    }
    try {
      const observed = state.streams.flatMap((stream) => {
        const source = [...state.observed]
          .reverse()
          .find(url =>
            stream.urls.some(
              candidate => resource(candidate) === resource(url),
            ),
          )
        return source ? [{ stream, source }] : []
      })
      // Ambiguous media paths are not safe to redirect to a selected quality/codec.
      const paths = observed.map(item => resource(item.source))
      if (!observed.length || new Set(paths).size !== paths.length) {
        state.diagnostic = {
          ...idle(),
          state: 'unavailable',
          message: '没有识别到可安全切换的当前媒体流，保持原线路。',
        }
        return state.diagnostic
      }
      const matched = ['video', 'audio'].flatMap(kind =>
        observed
          .filter(item => item.stream.kind === kind)
          .sort(
            (a, b) =>
              state.observed.indexOf(b.source)
              - state.observed.indexOf(a.source),
          )
          .slice(0, 1),
      )
      const missing = new Set<string>()
      for (const { stream, source } of matched.slice(0, 2)) {
        const currentUrl = new URL(source)
        const candidates = [
          source,
          ...stream.urls.filter((value) => {
            const url = new URL(value)
            return (
              url.origin !== currentUrl.origin
              || url.pathname !== currentUrl.pathname
            )
          }),
        ].slice(0, 3)
        const allowed: string[] = []
        for (const url of candidates) {
          if (await this.io.allowed(url))
            allowed.push(url)
          else missing.add(`${new URL(url).origin}/*`)
        }
        const probes = await Promise.allSettled(
          allowed.map(url => this.io.probe(url)),
        )
        if (this.states.get(tab) !== state)
          return idle()
        const best = fasterProbe(
          probes.flatMap(result =>
            result.status === 'fulfilled' ? [result.value] : [],
          ),
          source,
        )
        if (best) {
          const undo = await this.io.redirect(tab, source, best.url)
          if (this.states.get(tab) !== state) {
            await undo?.()
            return idle()
          }
          state.redirects.push({ source, target: best.url })
        }
      }
      const hosts = state.redirects.map(
        rule => new URL(rule.target).hostname,
      )
      state.diagnostic = {
        ...idle(),
        state: state.redirects.length ? 'optimized' : 'unavailable',
        message: state.redirects.length
          ? '已尝试同画质、同编码和同音轨的官方备用线路。仍卡顿时可手动重载播放器。'
          : '没有测到明显更快的可用备用线路，保持原线路。',
        hosts: [...new Set(hosts)],
        missingOrigins: [...missing],
        reloadSuggested:
          state.redirects.length > 0 && sample.waitingSeconds >= 10,
      }
    }
    catch {
      if (this.states.get(tab) === state) {
        await this.io.clearRules(tab)
        state.redirects = []
        state.diagnostic = {
          ...idle(),
          state: 'failed',
          message: '线路测试未成功，已保留原播放器线路。',
        }
      }
    }
    finally {
      this.busy.delete(tab)
      this.io.persist()
    }
    return state.diagnostic
  }
}
