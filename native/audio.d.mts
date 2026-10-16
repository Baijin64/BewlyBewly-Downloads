export const audioIds: { '64': number, '132': number, '192': number, dolby: number, hires: number }
export function audioRank(id: number): number
export function selectAudio<T extends { id: number, bandwidth?: number }>(tracks: T[], quality?: string): T | undefined
