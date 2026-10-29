import { describe, expect, it } from 'vitest'
import { buildL4Book, l4Task, runL4 } from './l4-overflow-fixture'
import { contextButtonLabel, emptyPinsByScope, pinScopeOf, pinsByScopeAfterRequest, toggleIncludedId, updatePinsByScope } from '../src/renderer/src/services/context-sources'

const snapIds = (snap: Record<string, unknown>): string[] => (snap.sources as Array<{ id: string }>).map((item) => item.id)
/** 模拟面板：按请求模式取对应那一组钉住发出。 */
const taskFor = (b: ReturnType<typeof buildL4Book>, mode: 'discussion' | 'consistency_check', pins: ReturnType<typeof emptyPinsByScope>) => {
  const ids = pins[pinScopeOf(mode)]
  return l4Task(b.project.id, b.chapterId, mode, ids.length ? { includedIds: ids } : {})
}

describe('钉住按模式分开', () => {
  it('pinScopeOf：只有 consistency_check 归「检查一致性」，其余模式都是「当前对话」', () => {
    expect(pinScopeOf('consistency_check')).toBe('consistency')
    for (const mode of ['discussion', 'generation', 'editing', 'reader_review', 'brainstorm']) expect(pinScopeOf(mode)).toBe('chat')
  })

  it('一致性检查里钉住一条设定，切回当前对话后不发出；一致性检查里照常发出；清单 = snapshot = 实发', async () => {
    const b = buildL4Book({ settings: 66, memories: 20 })
    let pins = updatePinsByScope(emptyPinsByScope(), 'consistency', (c) => toggleIncludedId(c, 'set-0000'))
    const chat = await runL4(b.db, taskFor(b, 'discussion', pins), 'chat')
    expect(chat.context.items.some((item) => item.id === 'set-0000')).toBe(false)
    expect(JSON.stringify(chat.sent)).not.toContain('设定0：')
    const unpinnedChat = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'discussion'), 'chat0')
    expect(chat.md5).toBe(unpinnedChat.md5) // 当前对话一组为空 → 与未钉住逐字一致
    const cons = await runL4(b.db, taskFor(b, 'consistency_check', pins), 'cons')
    expect(cons.context.items[0].id).toBe('set-0000'); expect(JSON.stringify(cons.sent)).toContain('设定0：')
    expect(snapIds(cons.snapshot)).toEqual(cons.preview.items.map((item) => item.id))
    expect(snapIds(cons.snapshot)).toEqual(cons.context.items.map((item) => item.id))
    pins = pinsByScopeAfterRequest(pins, 'chat') // 当前对话请求后整理，不动一致性那组
    expect(pins.consistency).toEqual(['set-0000'])
  })

  it('反向：当前对话里钉住的条目不进入一致性检查', async () => {
    const b = buildL4Book({ settings: 66, memories: 20 })
    const pins = updatePinsByScope(emptyPinsByScope(), 'chat', (c) => toggleIncludedId(c, 'set-0000'))
    const chat = await runL4(b.db, taskFor(b, 'discussion', pins), 'chat')
    expect(chat.context.items.some((item) => item.id === 'set-0000')).toBe(true)
    const cons = await runL4(b.db, taskFor(b, 'consistency_check', pins), 'cons')
    const base = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'consistency_check'), 'cons0')
    expect(cons.md5).toBe(base.md5)
    expect(cons.context.items.map((item) => item.id)).not.toContain('set-0000') // 第 66 名留在溢出组
  })

  it('计数只算当前模式；勾选大纲只在当前对话那组计入', () => {
    let pins = updatePinsByScope(emptyPinsByScope(), 'consistency', (c) => ['set-0000', 'tl-00230', ...c])
    pins = updatePinsByScope(pins, 'chat', (c) => [...c, 'mem-00001', 'outline:x'])
    expect(contextButtonLabel([], pins.chat)).toBe('上下文（勾选大纲 1·钉住 1）')
    expect(contextButtonLabel([], pins.consistency)).toBe('上下文（钉住 2）')
    expect(pinsByScopeAfterRequest(pins, 'chat')).toEqual({ chat: ['mem-00001'], consistency: ['set-0000', 'tl-00230'] })
  })

  it('切换对话（或重启）后两组都重置', () => {
    const pins = updatePinsByScope(updatePinsByScope(emptyPinsByScope(), 'chat', () => ['a']), 'consistency', () => ['b'])
    expect(pins).toEqual({ chat: ['a'], consistency: ['b'] })
    expect(emptyPinsByScope()).toEqual({ chat: [], consistency: [] }) // 面板切换对话时用的就是它；状态不持久化，重启即为初始值
  })
})
