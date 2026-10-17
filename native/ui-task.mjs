// Browser and native UI caches share this deliberately limited projection.
const fields = ['id', 'bvid', 'cid', 'title', 'part', 'page', 'author', 'uid', 'cover', 'createdAt', 'completedAt', 'options', 'status', 'stage', 'progress', 'speed', 'error', 'output', 'artifacts', 'warnings', 'filesDeleted', 'legacyPath']
export function uiTask(task) { return Object.fromEntries(fields.filter(key => task[key] !== undefined).map(key => [key, task[key]])) }
