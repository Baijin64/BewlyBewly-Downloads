import { isAbortError } from './broker'

export interface FeedPage<T> {
  items: T[]
  next: number
  done?: boolean
}

// One bounded loading cycle owns its cursor, cancellation and result generation.
export class FeedLoader<T> {
  items: T[] = []
  cursor = 1
  done = false
  loading = false
  active = true
  private revision = 0
  private pending?: Promise<void>
  private controller?: AbortController
  private seen = new Set<string>()

  constructor(private io: {
    page: (cursor: number, signal: AbortSignal) => Promise<FeedPage<T>>
    key: (item: T) => string
    changed: () => void
    error: () => void
  }) {}

  reset() {
    this.pause()
    this.active = true
    this.items = []
    this.cursor = 1
    this.done = false
    this.seen.clear()
    this.io.changed()
  }

  pause() {
    this.revision++
    this.active = false
    this.controller?.abort()
    this.pending = undefined
    this.loading = false
    this.io.changed()
  }

  resume() { this.active = true }

  load(options: { minPages?: number, maxPages?: number, target?: number, needsMore: () => Promise<boolean> }) {
    if (this.pending)
      return this.pending
    if (!this.active || this.done)
      return Promise.resolve()
    const revision = this.revision
    const controller = new AbortController()
    this.controller = controller
    const current = () => this.active && revision === this.revision && !controller.signal.aborted
    this.loading = true
    this.io.changed()
    const run = async () => {
      let emptyPages = 0
      try {
        for (let page = 0; page < (options.maxPages ?? 3) && current(); page++) {
          const result = await this.io.page(this.cursor, controller.signal)
          if (!current())
            return
          const added = result.items.filter((item) => {
            const key = this.io.key(item)
            if (this.seen.has(key))
              return false
            this.seen.add(key)
            return true
          })
          this.items = [...this.items, ...added]
          // Advance using the raw server page, including items hidden by filters.
          this.cursor = result.next
          this.done = !!result.done
          emptyPages = added.length ? 0 : emptyPages + 1
          this.io.changed()
          if (this.done || emptyPages >= 2)
            break
          if (page + 1 >= (options.minPages ?? 1) && this.items.length >= (options.target ?? 30) && !await options.needsMore())
            break
        }
      }
      catch (error) {
        if (current() && !isAbortError(error))
          this.io.error()
      }
      finally {
        if (revision === this.revision) {
          this.loading = false
          this.pending = undefined
          this.io.changed()
        }
      }
    }
    this.pending = Promise.resolve().then(run)
    return this.pending
  }
}
