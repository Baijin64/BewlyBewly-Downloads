export const loadingMethods = ['getRecommendVideos', 'getAppRecommendVideos', 'getVideoInfo', 'getVideoPreview'] as const
export type LoadingMethod = typeof loadingMethods[number]
export const abortError = () => new DOMException('Request cancelled', 'AbortError')
export const isAbortError = (error: unknown) => !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'

export function previewExpiry(url: string, now: number) {
  let expires = now + 30000
  try {
    const deadline = Number(new URL(url).searchParams.get('deadline'))
    if (deadline > 0)
      expires = Math.min(expires, deadline * 1000 - 10000)
  }
  catch { return now }
  return expires
}

interface Job {
  key: string
  controller: AbortController
  consumers: Map<string, { resolve: (value: any) => void, reject: (error: Error) => void }>
  load: (signal: AbortSignal) => Promise<any>
  preview: boolean
  ttl: (value: any) => number
  started: boolean
}

export class ResourceBroker {
  private jobs = new Map<string, Job>()
  private consumers = new Map<string, Job>()
  private queue: Job[] = []
  private cache = new Map<string, { value: any, expires: number }>()
  private active = 0
  private activePreviews = 0
  private clearing = false
  constructor(private now = Date.now) {}

  request(key: string, consumer: string, load: Job['load'], options: { preview: boolean, ttl: Job['ttl'] }) {
    const cached = this.cache.get(key)
    if (cached && cached.expires > this.now())
      return Promise.resolve(structuredClone(cached.value))
    this.cache.delete(key)
    if (this.consumers.has(consumer))
      return Promise.reject(new Error('Duplicate request identifier'))
    if (this.consumers.size >= 128)
      return Promise.reject(new Error('Too many loading requests'))
    let job = this.jobs.get(key)
    if (!job) {
      job = { key, load, controller: new AbortController(), consumers: new Map(), preview: options.preview, ttl: options.ttl, started: false }
      this.jobs.set(key, job)
      this.queue.push(job)
    }
    const selected = job
    const result = new Promise<any>((resolve, reject) => selected.consumers.set(consumer, { resolve, reject }))
    this.consumers.set(consumer, selected)
    this.pump()
    return result
  }

  cancel(consumer: string) {
    const job = this.consumers.get(consumer)
    if (!job)
      return
    job.consumers.get(consumer)?.reject(abortError())
    job.consumers.delete(consumer)
    this.consumers.delete(consumer)
    if (!job.consumers.size) {
      job.controller.abort()
      if (this.jobs.get(job.key) === job)
        this.jobs.delete(job.key)
      this.queue = this.queue.filter(item => item !== job)
    }
    this.pump()
  }

  clear(prefix = '') {
    this.clearing = true
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix))
        this.cache.delete(key)
    }
    for (const key of [...this.consumers.keys()]) {
      if (key.startsWith(prefix))
        this.cancel(key)
    }
    this.clearing = false
    this.pump()
  }

  private pump() {
    if (this.clearing)
      return
    while (this.active < 4) {
      const foreground = this.queue.findIndex(job => !job.preview)
      const index = foreground >= 0 ? foreground : this.activePreviews < 2 ? 0 : -1
      if (index < 0 || !this.queue.length)
        return
      const [job] = this.queue.splice(index, 1)
      if (!job.consumers.size)
        continue
      job.started = true
      this.active++
      if (job.preview)
        this.activePreviews++
      this.run(job)
    }
  }

  private async run(job: Job) {
    try {
      const value = await job.load(job.controller.signal)
      if (job.controller.signal.aborted)
        return
      const ttl = job.ttl(value)
      if (ttl > 0) {
        this.cache.set(job.key, { value: structuredClone(value), expires: this.now() + ttl })
        while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!)
      }
      for (const consumer of job.consumers.values()) consumer.resolve(value)
    }
    catch (error) {
      for (const consumer of job.consumers.values()) consumer.reject(isAbortError(error) ? abortError() : error instanceof Error ? error : new Error('Loading failed'))
    }
    finally {
      for (const key of job.consumers.keys()) this.consumers.delete(key)
      if (this.jobs.get(job.key) === job)
        this.jobs.delete(job.key)
      this.active--
      if (job.preview)
        this.activePreviews--
      this.pump()
    }
  }
}
