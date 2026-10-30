import type { DocumentContent, DocumentNode } from '../../../shared/domain'

/**
 * 保存回执后的章节树局部补丁：只改该章已知字段（字数、修订号、更新时间），不重拉全树。
 * 找不到该章（树还没加载、章被并发删/移）或回执比树里旧 → needsFullRefresh，由调用方放到空闲时全量刷新。
 */
export function patchTreeAfterSave(tree: DocumentNode[], saved: Pick<DocumentContent, 'documentId' | 'wordCount' | 'revision' | 'updatedAt'>): { tree: DocumentNode[]; needsFullRefresh: boolean } {
  const index = tree.findIndex((node) => node.id === saved.documentId)
  if (index < 0) return { tree, needsFullRefresh: true }
  const current = tree[index]
  if (current.revision > saved.revision) return { tree, needsFullRefresh: false }
  if (current.wordCount === saved.wordCount && current.revision === saved.revision && current.updatedAt === saved.updatedAt) return { tree, needsFullRefresh: false }
  const next = tree.slice()
  next[index] = { ...current, wordCount: saved.wordCount, revision: saved.revision, updatedAt: saved.updatedAt }
  return { tree: next, needsFullRefresh: false }
}

type IdleHost = {
  requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

/** 合并的空闲任务：多次 schedule 只跑一次；requestIdleCallback 带 timeout 兜底，没有 rIC 时退回 setTimeout。 */
export function createIdleTask(run: () => void, timeoutMs = 1000, host: IdleHost = globalThis as unknown as IdleHost): { schedule(): void; cancel(): void; pending(): boolean } {
  let handle: { kind: 'idle'; id: number } | { kind: 'timer'; id: unknown } | undefined
  const fire = (): void => { handle = undefined; run() }
  return {
    schedule() {
      if (handle) return
      if (typeof host.requestIdleCallback === 'function') handle = { kind: 'idle', id: host.requestIdleCallback(fire, { timeout: timeoutMs }) }
      else handle = { kind: 'timer', id: host.setTimeout(fire, Math.min(timeoutMs, 200)) }
    },
    cancel() {
      if (!handle) return
      if (handle.kind === 'idle') host.cancelIdleCallback?.(handle.id); else host.clearTimeout(handle.id)
      handle = undefined
    },
    pending: () => handle !== undefined
  }
}
