// PR-46：保存后章节树局部补丁 + 空闲全量刷新；measure 按 rAF 合帧
import { describe, expect, it, vi } from 'vitest'
import type { DocumentNode } from '../src/shared/domain'
import { createIdleTask, patchTreeAfterSave } from '../src/renderer/src/services/tree-patch'
import { createFrameCoalescer } from '../src/renderer/src/services/frame-coalescer'

const node = (id: string, extra: Partial<DocumentNode> = {}): DocumentNode => ({ id, projectId: 'p', parentId: 'v', type: 'chapter', title: id, orderIndex: 0, status: 'draft', wordCount: 10, revision: 1, createdAt: 1, updatedAt: 1, ...extra })

describe('patchTreeAfterSave', () => {
  it('只改该章的字数/修订号/更新时间，其余节点保持引用', () => {
    const tree = [node('v', { type: 'volume', parentId: null }), node('a'), node('b')]
    const { tree: next, needsFullRefresh } = patchTreeAfterSave(tree, { documentId: 'a', wordCount: 42, revision: 2, updatedAt: 9 })
    expect(needsFullRefresh).toBe(false)
    expect(next).not.toBe(tree)
    expect(next[1]).toEqual({ ...tree[1], wordCount: 42, revision: 2, updatedAt: 9 })
    expect(next[0]).toBe(tree[0]); expect(next[2]).toBe(tree[2])
    expect(next[1].title).toBe('a')
  })
  it('字段没变 → 原数组（不触发重渲染）', () => {
    const tree = [node('a')]
    expect(patchTreeAfterSave(tree, { documentId: 'a', wordCount: 10, revision: 1, updatedAt: 1 }).tree).toBe(tree)
  })
  it('回执比树里旧 → 不回滚', () => {
    const tree = [node('a', { revision: 5 })]
    const result = patchTreeAfterSave(tree, { documentId: 'a', wordCount: 1, revision: 4, updatedAt: 2 })
    expect(result.tree).toBe(tree); expect(result.needsFullRefresh).toBe(false)
  })
  it('章不在树里 → 需要全量刷新', () => {
    const tree = [node('a')]
    const result = patchTreeAfterSave(tree, { documentId: 'x', wordCount: 1, revision: 2, updatedAt: 2 })
    expect(result.tree).toBe(tree); expect(result.needsFullRefresh).toBe(true)
  })
})

describe('createIdleTask', () => {
  it('多次 schedule 合并为一次 requestIdleCallback，并带 timeout', () => {
    const calls: Array<{ cb: () => void; timeout?: number }> = []
    const host = { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => { calls.push({ cb, timeout: o?.timeout }); return calls.length }, cancelIdleCallback: vi.fn(), setTimeout: vi.fn(), clearTimeout: vi.fn() }
    const run = vi.fn()
    const task = createIdleTask(run, 1000, host)
    task.schedule(); task.schedule(); task.schedule()
    expect(calls).toHaveLength(1); expect(calls[0].timeout).toBe(1000)
    expect(run).not.toHaveBeenCalled()
    calls[0].cb(); expect(run).toHaveBeenCalledTimes(1); expect(task.pending()).toBe(false)
    task.schedule(); expect(calls).toHaveLength(2)
    task.cancel(); expect(host.cancelIdleCallback).toHaveBeenCalledWith(2)
  })
  it('没有 requestIdleCallback 时退回 setTimeout', () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn()
      const task = createIdleTask(run, 1000, { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) })
      task.schedule(); expect(run).not.toHaveBeenCalled()
      vi.advanceTimersByTime(250); expect(run).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})

describe('createFrameCoalescer', () => {
  const makeHost = () => { const frames = new Map<number, () => void>(); let id = 0; return { frames, host: { requestAnimationFrame: (cb: () => void) => { frames.set(++id, cb); return id }, cancelAnimationFrame: (n: number) => { frames.delete(n) } }, tick: () => { const list = [...frames.values()]; frames.clear(); list.forEach((cb) => cb()) } } }
  it('同一帧多次 schedule 只测一次', () => {
    const { host, frames, tick } = makeHost(); let key = 1; const run = vi.fn()
    const c = createFrameCoalescer(() => key, run, Object.is, host)
    c.schedule(); c.schedule(); c.schedule()
    expect(frames.size).toBe(1); expect(run).not.toHaveBeenCalled()
    tick(); expect(run).toHaveBeenCalledTimes(1)
    key = 2; c.schedule(); tick(); expect(run).toHaveBeenCalledTimes(2)
  })
  it('尺寸和内容都没变 → 跳过', () => {
    const { host, tick } = makeHost(); const doc = {}; const run = vi.fn()
    let key = { width: 100, doc }
    const c = createFrameCoalescer(() => key, run, (a, b) => a.width === b.width && a.doc === b.doc, host)
    c.flush(); expect(run).toHaveBeenCalledTimes(1)
    key = { width: 100, doc }; c.schedule(); tick(); expect(run).toHaveBeenCalledTimes(1)
    key = { width: 120, doc }; c.schedule(); tick(); expect(run).toHaveBeenCalledTimes(2)
    key = { width: 120, doc: {} }; c.schedule(); tick(); expect(run).toHaveBeenCalledTimes(3)
    c.invalidate(); c.flush(); expect(run).toHaveBeenCalledTimes(4)
  })
  it('key 为 undefined（DOM 未就绪）不测；cancel 取消挂起的帧；flush 同步', () => {
    const { host, frames } = makeHost(); let key: number | undefined; const run = vi.fn()
    const c = createFrameCoalescer(() => key, run, Object.is, host)
    c.flush(); expect(run).not.toHaveBeenCalled()
    key = 1; c.schedule(); c.cancel(); expect(frames.size).toBe(0)
    c.flush(); expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('保存回执不同步触发全量 refreshTree', () => {
  it('WorkspaceScreen 的 onSaved 只打补丁', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/renderer/src/screens/WorkspaceScreen.tsx', import.meta.url), 'utf8')
    const handler = source.match(/onSaved=\{\(saved\) => \{([^}]*)\}/)?.[1] ?? ''
    expect(handler).toContain('patchTreeOnSave(saved)')
    expect(handler).not.toContain('refreshTree')
  })
})
