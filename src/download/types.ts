export type OutputKind = 'video' | 'silent' | 'audio' | 'mp3' | 'cover' | 'xml' | 'ass' | 'srt' | 'nfo'
export interface DownloadOptions {
  quality: number
  codec: 'auto' | 'avc' | 'hevc' | 'av1'
  audioQuality: 'auto' | '64' | '132' | '192' | 'dolby' | 'hires'
  mode: 'video' | 'audio'
  cover: boolean
  subtitles: boolean
  outputs: OutputKind[]
  subtitleLanguages: string[]
  filenameTemplate: string
  folderTemplate: string
  createFolder: boolean
  createFolderAddIndex: boolean
}

export const defaultOptions: DownloadOptions = {
  quality: 0,
  codec: 'auto',
  audioQuality: 'auto',
  mode: 'video',
  cover: false,
  subtitles: false,
  outputs: ['video'],
  subtitleLanguages: [],
  filenameTemplate: '%title% [%bv%-%cid%]',
  folderTemplate: '',
  createFolder: false,
  createFolderAddIndex: false,
}

export function normalizeDownloadOptions(value: Partial<DownloadOptions>): DownloadOptions {
  return {
    ...defaultOptions,
    ...value,
    outputs: value.outputs ? [...value.outputs] : [value.mode === 'audio' ? 'audio' : 'video', ...(value.cover ? ['cover' as const] : []), ...(value.subtitles ? ['srt' as const] : [])],
    subtitleLanguages: [...(value.subtitleLanguages || [])],
  }
}

export interface DownloadVideo {
  requestedPage?: number
  bvid: string
  title: string
  author: string
  uid?: number
  pubdate?: number
  description?: string
  cover: string
  pages: { cid: number, page: number, title: string, duration: number }[]
  collection?: { id: number, title: string, sections: { id: number, title: string, videos: { bvid: string, cid: number, title: string, available: boolean }[] }[] }
  group?: { title: string, index: number }
}

export interface AvailableVideoFormat {
  quality: number
  codec: number
}

export interface AvailableAudioFormat {
  id: number
  bandwidth: number
}
export interface AvailableMediaFormats {
  video: AvailableVideoFormat[]
  audio: AvailableAudioFormat[]
}

export interface DownloadTask {
  id: string
  bvid: string
  cid: number
  title: string
  part: string
  page?: number
  author?: string
  uid?: number
  cover?: string
  createdAt?: string
  completedAt?: string
  options: DownloadOptions
  status: 'pending' | 'queued' | 'resolving' | 'downloading' | 'paused' | 'muxing' | 'postprocessing' | 'completed' | 'failed' | 'cancelled'
  stage?: string
  progress: number
  speed: number
  error: string
  output?: string
  artifacts?: Record<string, string>
  warnings?: string[]
  duplicate?: boolean
  filesDeleted?: boolean
  legacyPath?: string
}

export interface HelperSettings {
  directory: string
  maxConcurrent: number
  defaultOptions?: DownloadOptions
  features: Record<'cover' | 'audio' | 'xml' | 'ass' | 'nfo' | 'srt' | 'tools', boolean>
  soundTip: boolean
  shutdown: boolean
  listenClipboard: boolean
  idleExitMinutes: number
  tray: boolean
}
export interface HelperStatus {
  version: string
  storageError?: string
  protocol?: number
  capabilities?: string[]
  settings: HelperSettings
  engineInstalled: boolean
}
export interface TaskQuery {
  items: DownloadTask[]
  storageError?: string
  total: number
  page: number
  pageSize: number
  counts: { pending: number, active: number, completed: number, failed: number }
}
export type DownloadMethod = 'health' | 'inspect' | 'inspectSubtitles' | 'inspectQualities' | 'inspectFormats' | 'createTasks' | 'stageTasks' | 'listTasks' | 'queryTasks' | 'taskAction' | 'batchAction' | 'configure' | 'previewPath' | 'taskFile' | 'tool' | 'migrationPreview' | 'migrationImport'
export type DownloadReply<T> = { ok: true, result: T } | { ok: false, error: string }
