export const audioIds: Record<string, number> = { '64': 30216, '132': 30232, '192': 30280, dolby: 30250, hires: 30251 }

export function audioRank(id: number): number {
  return ({ 30251: 5, 30250: 4, 30280: 3, 30232: 2, 30216: 1 })[id] || 0
}

// Both the browser and durable queue use the same preference order. Bitrate
// breaks ties within a tier; it must not outrank a lossless or Dolby track.
export function selectAudio<T extends { id: number, bandwidth?: number }>(tracks: T[], quality = 'auto'): T | undefined {
  return tracks.filter(track => quality === 'auto' ? audioRank(track.id) > 0 : track.id === audioIds[quality])
    .sort((a, b) => audioRank(b.id) - audioRank(a.id) || (b.bandwidth || 0) - (a.bandwidth || 0))[0]
}
