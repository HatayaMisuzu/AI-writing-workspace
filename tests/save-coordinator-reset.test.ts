import { describe, it, expect } from 'vitest'
import { SaveCoordinator } from '../src/renderer/src/services/save-coordinator'

// 回归：审计 H-4 —— resetRevision 需在有 pending（无在途保存）时同步修正基准 revision
describe('SaveCoordinator resetRevision（审计 H-4 回归）', () => {
  it('有 pending 且无在途保存时，resetRevision 同步 revision 与 pending.baseRevision', async () => {
    const coord = new SaveCoordinator(
      5,
      async (snapshot) => ({ documentId: 'd', projectId: 'p', editorJson: {}, plainText: snapshot.plainText, wordCount: 1, revision: snapshot.baseRevision + 1, updatedAt: Date.now() }),
      () => undefined,
      () => undefined,
      10
    )
    coord.markDirty({ editorJson: {}, plainText: '未保存缓冲' })
    // 模拟快照恢复后服务端 revision 跳到 42
    coord.resetRevision(42)
    expect(coord.currentRevision()).toBe(42)
    await coord.flush() // 不应 REVISION_CONFLICT：baseRevision 已被同步为 42
    expect(coord.currentRevision()).toBe(43)
  })

  it('在途保存期间 resetRevision 保持拒绝，避免竞态', async () => {
    let releaseSave: ((value: unknown) => void) | undefined
    const gate = new Promise((resolve) => { releaseSave = resolve })
    const coord = new SaveCoordinator(
      0,
      async (snapshot) => { await gate; return { documentId: 'd', projectId: 'p', editorJson: {}, plainText: snapshot.plainText, wordCount: 1, revision: snapshot.baseRevision + 1, updatedAt: Date.now() } },
      () => undefined,
      () => undefined,
      10
    )
    coord.markDirty({ editorJson: {}, plainText: 'v1' })
    const flushing = coord.flush()
    coord.resetRevision(99) // drain 在途，应被忽略
    expect(coord.currentRevision()).not.toBe(99)
    releaseSave?.(undefined)
    await flushing
  })
})
