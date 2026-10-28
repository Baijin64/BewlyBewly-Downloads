// Browser and native UI caches share this deliberately limited projection.
const fields = ['id', 'bvid', 'cid', 'title', 'part', 'page', 'author', 'uid', 'cover', 'createdAt', 'completedAt', 'options', 'status', 'stage', 'progress', 'speed', 'error', 'output', 'artifacts', 'warnings', 'filesDeleted', 'legacyPath']

export function uiTask<T extends object>(task: T): T {
  const record = task as Record<string, any>
  return Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]])) as T
}
