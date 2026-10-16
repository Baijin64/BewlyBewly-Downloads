const values = {}
const recommend = page => ({ code: 0, data: { item: Array.from({ length: 30 }, (_, index) => ({ id: (page - 1) * 30 + index + 1, bvid: 'BV' + String((page - 1) * 30 + index + 1).padStart(10, '0'), title: `加载性能验收 · 示例视频 ${String((page - 1) * 30 + index + 1).padStart(2, '0')}`, pic: 'https://i2.hdslb.com/bfs/archive/1ada8c32a9d168e4b2ee3e010f24789ba3353785.jpg', duration: 180, owner: { name: '示例 UP 主', face: 'https://i2.hdslb.com/bfs/archive/1ada8c32a9d168e4b2ee3e010f24789ba3353785.jpg', mid: 12345 }, stat: { view: 12345, danmaku: 123 }, pubdate: 1792108800, cid: 42 })) } })
export const storage = { local: { async get(key) { return { [key]: values[key] } }, async set(data) { Object.assign(values, data) }, async remove(key) { delete values[key] } }, onChanged: { addListener() {}, removeListener() {} } }
let installed = true
let playbackEnabled = false
export function setInstalled(value) { installed = value }
const options = { quality: 0, codec: 'auto', audioQuality: 'auto', mode: 'video', cover: false, subtitles: false, outputs: ['video'], subtitleLanguages: [], filenameTemplate: '%title% [%bv%-%cid%]', folderTemplate: '', createFolder: false, createFolderAddIndex: false }
let settings = { directory: 'D:\\Videos\\Bilibili', maxConcurrent: 4, soundTip: true, shutdown: false, listenClipboard: false, tray: true, idleExitMinutes: 0, features: { cover: true, audio: true, xml: true, ass: true, nfo: true, srt: true, tools: true }, defaultOptions: options }
const fixture = (id, title, status, part = title) => ({ id, bvid: 'BV1GJ411x7h7', cid: 42, title, part, author: '示例 UP 主', uid: 12345, cover: 'https://i2.hdslb.com/bfs/archive/1ada8c32a9d168e4b2ee3e010f24789ba3353785.jpg', createdAt: '2026-10-16T14:32:00Z', ...(status === 'completed' ? { completedAt: '2026-10-16T14:36:00Z' } : {}), page: 1, options: { ...options }, status, stage: 'video', progress: 62, speed: 5242880, error: '' })
const tasks = [
  fixture('pending-1', '从网页到本地：建立自己的视频资料库', 'pending', '第一集 · 下载与整理'),
  fixture('pending-2', '为什么我们需要更好的下载管理器', 'pending'),
  fixture('pending-3', '探索宇宙的边界：韦布望远镜的新发现', 'pending'),
  fixture('active-1', '一口气看懂现代计算机', 'downloading', '第八章 · 从逻辑门到处理器'),
  { ...fixture('done-1', '一场关于人工智能的长谈', 'completed'), output: 'D:\\Videos\\Bilibili\\一场关于人工智能的长谈.mp4' },
  { ...fixture('done-2', '旧版导入：没有封面和完成时间的记录', 'completed'), cover: '', author: '', uid: undefined, completedAt: undefined },
  { ...fixture('done-3', '另一段值得收藏的视频', 'completed'), author: '影像记录者', completedAt: '2026-10-09 19:32', options: { ...options, outputs: ['video', 'cover', 'nfo'] } },
  { ...fixture('failed-1', '消失在时间里的声音', 'failed'), error: '当前账号或视频没有所选音质，没有自动替换音轨' },
]
const groups = { pending: ['pending'], active: ['queued', 'resolving', 'downloading', 'paused', 'muxing', 'postprocessing'], completed: ['completed'], failed: ['failed', 'cancelled'] }
const collection = { id: 7, title: '从网页到本地：完整教程', sections: [
  { id: 1, title: '入门与界面', videos: [{ bvid: 'BV1GJ411x7h7', cid: 42, title: '插件与下载核心', available: true }, { bvid: 'BV17x411w7KC', cid: 44, title: '合集、分 P 与队列', available: true }] },
  { id: 2, title: '进阶功能', videos: [{ bvid: 'BV1qxdmBKE2M', cid: 45, title: '高规格音视频与字幕', available: true }] },
] }
export default {
  storage,
  runtime: {
    getURL(path) { return '/' + path },
    async sendMessage({ method, params, bewlyPlayback, bewlyResource, contentScriptQuery, ...rest }) {
      if (bewlyResource) {
        if (method === 'cancel') return { ok: true }
        await new Promise(resolve => setTimeout(resolve, 120))
        if (method === 'getRecommendVideos') return { ok: true, result: structuredClone(recommend(params.fresh_idx || 1)) }
        if (method === 'getVideoInfo') return { ok: true, result: { code: 0, data: { cid: 42 } } }
        return { ok: true, result: { code: 0, data: { durl: [] } } }
      }
      if (contentScriptQuery === 'getRecommendVideos') return structuredClone(recommend(rest.fresh_idx || 1))
      if (bewlyPlayback) {
        if (method === 'enable') playbackEnabled = true
        if (method === 'disable') playbackEnabled = false
        return { ok: true, result: { enabled: playbackEnabled } }
      }
      await new Promise(resolve => setTimeout(resolve, 80))
      if (!installed) return { ok: false, error: '请先安装 Bewly 下载助手，并从开始菜单打开一次完成浏览器连接。然后点击重试。' }
      let result
      if (method === 'health') result = { version: '0.2.2', protocol: 2, capabilities: ['audio-highest'], engineInstalled: true, settings }
      else if (method === 'inspect') {
        const bvid = params.video
        result = { bvid, title: bvid === 'BV1GJ411x7h7' ? '从网页到本地：建立自己的视频资料库' : '合集、分 P 与队列', author: '示例 UP 主', collection, pages: bvid === 'BV1GJ411x7h7' ? [{ cid: 42, page: 1, title: '插件与下载核心', duration: 120 }, { cid: 43, page: 2, title: '字幕与视频合并', duration: 180 }] : [{ cid: bvid === 'BV17x411w7KC' ? 44 : 45, page: 1, title: '完整教程', duration: 120 }] }
      }
      else if (method === 'queryTasks') {
        const filtered = tasks.filter(task => (!groups[params.tab] || groups[params.tab].includes(task.status)) && (!params.search || task.title.includes(params.search)))
        result = { items: filtered.slice(((params.page || 1) - 1) * (params.pageSize || 50), (params.page || 1) * (params.pageSize || 50)), total: filtered.length, page: params.page || 1, pageSize: params.pageSize || 50, counts: Object.fromEntries(Object.entries(groups).map(([key, states]) => [key, tasks.filter(task => states.includes(task.status)).length])) }
      }
      else if (method === 'inspectFormats') result = params.video === 'BV1GJ411x7h7' ? { video: [{ quality: 80, codec: 7 }, { quality: 80, codec: 12 }], audio: [{ id: 30216, bandwidth: 64000 }, { id: 30280, bandwidth: 192000 }] } : { video: [{ quality: 127, codec: 13 }, { quality: 126, codec: 12 }, { quality: 80, codec: 7 }], audio: [{ id: 30280, bandwidth: 192000 }, { id: 30250, bandwidth: 256000 }, { id: 30251, bandwidth: 1000000 }] }
      else if (method === 'inspectQualities') result = params.video === 'BV1GJ411x7h7' ? [{ quality: 80, codec: 7 }, { quality: 80, codec: 12 }] : [{ quality: 127, codec: 13 }, { quality: 126, codec: 12 }, { quality: 80, codec: 7 }]
      else if (method === 'inspectSubtitles') result = [{ language: 'zh-CN', label: '中文' }, { language: 'en', label: '英语' }]
      else if (method === 'listTasks') result = tasks
      else if (method === 'configure') result = settings = { ...settings, ...params }
      else if (method === 'previewPath') {
        const values = { title: params.task.part || params.task.title, part: params.task.part || params.task.title, upnn: '示例 UP 主', uid: '12345', bv: params.task.bvid, cid: String(params.task.cid), aqn: '192K', vqn: '1080P', collection: params.task.group?.title || params.task.title, index: '1', 'index:0': '0', 'index:00': '00', 'index:01': '01', dd: '2026-10-16', pd: '2026-04-21', 'dd:YYYY': '2026', 'dd:MM': '10', 'dd:DD': '16', 'dd:YYYYMMDD': '20261016', 'pd:YYYY': '2026', 'pd:MM': '04', 'pd:DD': '21', 'pd:YYYYMMDD': '20260421' }
        const format = value => String(value || '').replace(/%([^%]+)%/g, (match, key) => values[key] ?? match)
        result = { directory: settings.directory + (params.options.folderTemplate ? '\\' + format(params.options.folderTemplate).replaceAll('/', '\\') : ''), basename: format(params.options.filenameTemplate) }
      }
      else if (['createTasks', 'stageTasks'].includes(method)) {
        result = params.cids.map(cid => ({ ...fixture('new-' + cid + '-' + Date.now(), '新加入的视频', method === 'stageTasks' ? 'pending' : 'queued'), cid, options: params.options }))
        tasks.push(...result)
      }
      else if (method === 'batchAction') {
        const selection = tasks.filter(task => params.all ? groups[params.all].includes(task.status) : params.ids.includes(task.id))
        for (const task of selection) {
          if (params.action === 'edit') task.options = params.options
          else if (params.action === 'remove') tasks.splice(tasks.indexOf(task), 1)
          else task.status = ({ pause: 'paused', cancel: 'cancelled', resume: 'queued', retry: 'queued', start: 'queued' })[params.action] || task.status
        }
        result = { results: selection, processed: selection.length, errors: [] }
      }
      else if (method === 'tool') result = { id: 'tool-preview', status: 'completed', result: { text: 'BV17x411w7KC', path: null } }
      else if (method === 'migrationPreview') result = { id: 'preview', changes: [{ key: 'maxConcurrent', before: 2, after: 4 }], total: 12, duplicate: 1, invalid: 0, missingDirectories: 0, warnings: ['本页使用模拟数据；不读取旧程序或登录信息。'], sample: [] }
      else if (method === 'migrationImport') result = { settings: 1, imported: 11 }
      else result = {}
      // Match extension messaging: each reply is a fresh structured clone.
      return { ok: true, result: structuredClone(result) }
    },
  },
}
