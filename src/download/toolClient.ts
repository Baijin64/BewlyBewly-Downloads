import { downloadRequest } from './client'

interface ToolJob<T> { id: string, status: 'running' | 'completed' | 'failed', result?: T, error?: string }
export async function runTool<T>(params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let job = await downloadRequest<ToolJob<T>>('tool', params)
  while (job.status === 'running') {
    if (signal?.aborted) {
      await downloadRequest('tool', { op: 'cancel', id: job.id }).catch(() => {})
      throw new Error('已取消工具操作')
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
    job = await downloadRequest<ToolJob<T>>('tool', { op: 'status', id: job.id })
  }
  if (job.status === 'failed')
    throw new Error(job.error || '工具运行失败')
  return job.result as T
}
export async function pickLocalFile(kind: string, path?: string, signal?: AbortSignal) {
  const result = await runTool<{ path: string | null } >({ op: 'pick', kind, path }, signal)
  return result.path
}
