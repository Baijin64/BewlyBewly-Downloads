export class CompletionPolicy {
  constructor() { this.ids = new Set(); this.due = 0; this.cancelled = false; this.completed = 0 }
  begin(tasks) {
    if (!tasks.some(task => ['queued', 'resolving', 'downloading', 'paused', 'muxing', 'postprocessing'].includes(task.status))) {
      this.ids.clear(); this.cancelled = false
    }
    this.due = 0
  }
  started(task) { this.ids.add(task.id); this.due = 0 }
  finished() { this.completed++ }
  cancel() { this.cancelled = true; this.due = 0 }
  evaluate(tasks, enabled, now = Date.now()) {
    const waiting = tasks.some(task => ['pending', 'queued', 'resolving', 'downloading', 'paused', 'muxing', 'postprocessing'].includes(task.status))
    const allSucceeded = this.ids.size > 0 && [...this.ids].every(id => {
      const task = tasks.find(task => task.id === id)
      return task?.status === 'completed' && !task.warnings?.length
    })
    if (!enabled || waiting || !allSucceeded || this.cancelled) { this.due = 0; return 0 }
    if (!this.due) this.due = now + 30000
    return this.due
  }
}
