import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentContent } from '../src/shared/domain'
import { SAVE_IDLE_DELAY_MS, SAVE_MAX_WAIT_MS, SaveCoordinator } from '../src/renderer/src/services/save-coordinator'

const content = (plainText: string, revision: number): DocumentContent => ({
  documentId: 'chapter', projectId: 'project', editorJson: { type: 'doc' }, plainText, wordCount: plainText.length, revision, updatedAt: Date.now()
})

describe('按键性能：自动保存节奏（停顿 700ms / 连续输入最迟 2000ms）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const setup = () => {
    const saves: Array<{ at: number; text: string }> = []
    const start = Date.now()
    const coordinator = new SaveCoordinator(0, async (snapshot) => { saves.push({ at: Date.now() - start, text: snapshot.plainText }); return content(snapshot.plainText, snapshot.baseRevision + 1) }, () => undefined, () => undefined)
    let text = ''
    const type = (): void => { text += '字'; coordinator.markDirty({ editorJson: {}, plainText: text }); coordinator.schedule() }
    return { saves, coordinator, type, text: () => text, start }
  }

  it('常量即文档写明的上限', () => { expect(SAVE_IDLE_DELAY_MS).toBe(700); expect(SAVE_MAX_WAIT_MS).toBe(2000) })

  it('停顿：最后一次输入 700ms 后保存一次', async () => {
    const { saves, type } = setup()
    type(); await vi.advanceTimersByTimeAsync(699); expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1); expect(saves).toHaveLength(1)
  })

  it('连续输入（每 50ms 一键、持续 6s）：防抖不会无限推迟，任意时刻未落盘的输入都不超过 2000ms', async () => {
    const { saves, type, start } = setup()
    const typedAt: number[] = []
    for (let i = 0; i < 120; i += 1) { type(); typedAt.push(Date.now() - start); await vi.advanceTimersByTimeAsync(50) }
    expect(saves.length).toBeGreaterThanOrEqual(2)
    // 任一时刻 t，已落盘长度覆盖 t-2000ms 之前的全部输入
    for (let t = 0; t <= 6000; t += 10) {
      const persisted = saves.filter((save) => save.at <= t).at(-1)?.text.length ?? 0
      const mustHave = typedAt.filter((at) => at < t - SAVE_MAX_WAIT_MS).length
      expect(persisted, `t=${t}`).toBeGreaterThanOrEqual(mustHave)
    }
    for (let i = 1; i < saves.length; i += 1) expect(saves[i].at - saves[i - 1].at).toBeLessThanOrEqual(SAVE_MAX_WAIT_MS)
  })

  it('flush 后重新计时：新一轮改动仍按 700ms 停顿保存', async () => {
    const { saves, type, coordinator } = setup()
    type(); await coordinator.flush(); expect(saves).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5000)
    type(); await vi.advanceTimersByTimeAsync(699); expect(saves).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1); expect(saves).toHaveLength(2)
  })
})
