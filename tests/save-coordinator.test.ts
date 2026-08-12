import { describe, expect, it, vi } from 'vitest'
import type { DocumentContent } from '../src/shared/domain'
import { SaveCoordinator } from '../src/renderer/src/services/save-coordinator'
import { flushBeforeNavigate, handleBeforeClose } from '../src/renderer/src/services/close-handler'

const content = (plainText: string, revision: number): DocumentContent => ({
  documentId: 'chapter', projectId: 'project', editorJson: { type: 'doc' }, plainText,
  wordCount: plainText.length, revision, updatedAt: Date.now()
})

describe('reliable save coordinator', () => {
  it('flushes a debounced edit immediately', async () => {
    const saved: string[] = []
    const coordinator = new SaveCoordinator(0, async (snapshot) => { saved.push(snapshot.plainText); return content(snapshot.plainText, 1) }, () => undefined, () => undefined, 10_000)
    coordinator.markDirty({ editorJson: { type: 'doc' }, plainText: '最后一句' }); coordinator.schedule()
    await coordinator.flush()
    expect(saved).toEqual(['最后一句'])
    expect(coordinator.hasPending()).toBe(false)
  })

  it('serializes an in-flight save and persists the newest edit with consecutive revisions', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const revisions: number[] = []; const texts: string[] = []
    const coordinator = new SaveCoordinator(0, async (snapshot) => {
      revisions.push(snapshot.baseRevision); texts.push(snapshot.plainText)
      if (texts.length === 1) await firstGate
      return content(snapshot.plainText, snapshot.baseRevision + 1)
    }, () => undefined, () => undefined)
    coordinator.markDirty({ editorJson: {}, plainText: 'A' })
    const flushing = coordinator.flush()
    await Promise.resolve()
    coordinator.markDirty({ editorJson: {}, plainText: 'B' })
    const secondFlush = coordinator.flush()
    releaseFirst(); await Promise.all([flushing, secondFlush])
    expect(texts).toEqual(['A', 'B'])
    expect(revisions).toEqual([0, 1])
    expect(coordinator.currentRevision()).toBe(2)
  })

  it('blocks navigation on save failure and confirms close only after save', async () => {
    const navigate = vi.fn()
    await expect(flushBeforeNavigate(async () => { throw new Error('disk full') }, navigate)).rejects.toThrow('disk full')
    expect(navigate).not.toHaveBeenCalled()

    const order: string[] = []
    const result = await handleBeforeClose(async () => { order.push('flush') }, async () => { order.push('confirm') }, async () => { order.push('cancel') })
    expect(result.closed).toBe(true)
    expect(order).toEqual(['flush', 'confirm'])
  })

  it('cancels close when flush fails and retains pending data', async () => {
    const cancel = vi.fn(async () => undefined); const confirm = vi.fn(async () => undefined)
    const result = await handleBeforeClose(async () => { throw new Error('conflict') }, confirm, cancel)
    expect(result.closed).toBe(false); expect(confirm).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce()
  })
})
