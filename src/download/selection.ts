import type { DownloadVideo } from './types'

export interface SelectionRow {
  bvid: string
  cid?: number
  title: string
  section: string
  page?: number
  available: boolean
}

export function selectionRows(sources: DownloadVideo[], collections: boolean, expanded: string[], loaded: Record<string, DownloadVideo>): SelectionRow[] {
  const rows: SelectionRow[] = []
  const seen = new Set<string>()
  const add = (row: SelectionRow) => {
    const id = `${row.bvid}:${row.cid ?? '*'}`
    if (!seen.has(id)) {
      seen.add(id)
      rows.push(row)
    }
  }
  // A video already included by a collection needs only one selection row.
  const collectionIds = new Set(collections ? sources.flatMap(source => source.collection?.sections.flatMap(section => section.videos.map(video => video.bvid)) || []) : [])
  for (const source of sources) {
    if (collections && source.collection?.sections.some(section => section.videos.length)) {
      for (const section of source.collection.sections) {
        for (const video of section.videos) {
          const heading = sources.length > 1 ? `${source.collection.title} · ${section.title}` : section.title
          if (expanded.includes(video.bvid) && loaded[video.bvid]) {
            for (const part of loaded[video.bvid].pages)
              add({ bvid: video.bvid, cid: part.cid, title: `${video.title} · ${part.title}`, page: part.page, section: heading, available: video.available })
          }
          else {
            add({ bvid: video.bvid, title: video.title, section: heading, available: video.available })
          }
        }
      }
    }
    else if (!collectionIds.has(source.bvid)) {
      for (const part of source.pages)
        add({ bvid: source.bvid, cid: part.cid, title: part.title, page: part.page, section: source.title, available: true })
    }
  }
  return rows
}

export function selectionGroup(sources: DownloadVideo[], bvid: string) {
  for (const source of sources) {
    if (!source.collection)
      continue
    const index = source.collection.sections.flatMap(section => section.videos).findIndex(video => video.bvid === bvid)
    if (index >= 0)
      return { title: source.collection.title, index: index + 1 }
  }
}
