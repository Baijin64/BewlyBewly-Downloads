export class ServiceLifetime {
  constructor(mode = 'manual', now = Date.now, graceMs = 5000) {
    this.mode = mode === 'on-demand' ? 'on-demand' : 'manual'
    this.now = now
    this.graceMs = graceMs
    this.idleSince = now()
  }
  manual() { this.mode = 'manual'; this.idleSince = this.now() }
  touch() { this.idleSince = this.now() }
  snapshot(busy, manualIdleMinutes = 0) {
    const now = this.now()
    if (busy) this.idleSince = undefined
    else if (this.idleSince === undefined) this.idleSince = now
    const delay = this.mode === 'on-demand' ? this.graceMs : manualIdleMinutes * 60000
    const exitAt = !busy && delay > 0 ? this.idleSince + delay : undefined
    return { running: true, mode: this.mode, state: busy ? 'busy' : 'idle', exitAt }
  }
}
