import { describe, expect, it } from 'vitest'
import { ContextEngine } from '../src/main/ai/context-engine'
import { buildL4Book, l4Task, runL4 } from './l4-overflow-fixture'
import { contextButtonLabel, emptyPinsByScope, toggleExcludedId, toContextSourceRows, visibleExcludedIds, pinScopeOf, pinsByScopeAfterRequest, toggleIncludedId, updatePinsByScope } from '../src/renderer/src/services/context-sources'

const snapIds = (snap: Record<string, unknown>): string[] => (snap.sources as Array<{ id: string }>).map((item) => item.id)
/** 模拟面板：按请求模式取对应那一组钉住发出。 */
const taskFor = (b: ReturnType<typeof buildL4Book>, mode: 'discussion' | 'consistency_check', pins: ReturnType<typeof emptyPinsByScope>, excl = emptyPinsByScope()) => {
  const ids = pins[pinScopeOf(mode)]; const ex = excl[pinScopeOf(mode)]
  return l4Task(b.project.id, b.chapterId, mode, { ...(ids.length ? { includedIds: ids } : {}), ...(ex.length ? { excludedIds: ex } : {}) })
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

  it('排除按模式分开：一致性检查里排除一条设定，当前对话照常发出；一致性检查里不发出并标「已排除」', async () => {
    const b = buildL4Book({ settings: 66, memories: 20 })
    const chatBase = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'discussion'), 'c0')
    const target = chatBase.context.items.find((item) => item.id.startsWith('set-'))!.id
    const excl = updatePinsByScope(emptyPinsByScope(), 'consistency', (c) => toggleExcludedId(c, target))
    const chat = await runL4(b.db, taskFor(b, 'discussion', emptyPinsByScope(), excl), 'c1')
    expect(chat.md5).toBe(chatBase.md5)
    const cons = await runL4(b.db, taskFor(b, 'consistency_check', emptyPinsByScope(), excl), 'k1')
    expect(cons.context.items.some((item) => item.id === target)).toBe(false)
    expect(cons.context.metadata.omitted).toContainEqual(expect.objectContaining({ id: target, reason: 'user_excluded' }))
    expect(snapIds(cons.snapshot)).toEqual(cons.context.items.map((item) => item.id))
    expect(snapIds(cons.snapshot)).toEqual(cons.preview.items.map((item) => item.id))
  })

  it('排除反向：当前对话里排除的条目，一致性检查照常发出', async () => {
    const b = buildL4Book({ settings: 66, memories: 20 })
    const consBase = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'consistency_check'), 'k0')
    const excl = updatePinsByScope(emptyPinsByScope(), 'chat', (c) => toggleExcludedId(toggleExcludedId(c, 'set-0065'), 'mem-00019'))
    const cons = await runL4(b.db, taskFor(b, 'consistency_check', emptyPinsByScope(), excl), 'k1')
    expect(cons.md5).toBe(consBase.md5)
    const chat = await runL4(b.db, taskFor(b, 'discussion', emptyPinsByScope(), excl), 'c1')
    expect(chat.context.items.map((item) => item.id)).not.toContain('mem-00019')
    expect(snapIds(chat.snapshot)).toEqual(chat.context.items.map((item) => item.id))
  })

  it('「排除 N」只算当前模式且只算当前清单可见的条目', () => {
    const b = buildL4Book({ memories: 20 })
    const chatRows = toContextSourceRows(new ContextEngine(b.db).build(l4Task(b.project.id, b.chapterId, 'discussion', { excludedIds: ['mem-00019', 'not-in-list'] })))
    const excl = { chat: ['mem-00019', 'not-in-list'], consistency: ['set-0001', 'set-0002'] }
    expect(visibleExcludedIds(excl.chat, chatRows)).toEqual(['mem-00019'])
    expect(contextButtonLabel(visibleExcludedIds(excl.chat, chatRows), [])).toBe('上下文（排除 1）')
    expect(visibleExcludedIds(excl.consistency, chatRows)).toEqual([])
    expect(contextButtonLabel(visibleExcludedIds([], chatRows), [])).toBe('上下文')
  })

  it('已排除记忆的标题显示内容摘要（与超限列表一致），发送内容中的标题不变', () => {
    const b = buildL4Book({ memories: 20 })
    const engine = new ContextEngine(b.db)
    const base = engine.build(l4Task(b.project.id, b.chapterId, 'discussion'))
    const id = base.items.find((item) => item.kind === 'memory')!.id
    const sentTitle = base.items.find((item) => item.id === id)!.title
    const ex = engine.build(l4Task(b.project.id, b.chapterId, 'discussion', { excludedIds: [id] }))
    const row = ex.metadata.omitted!.find((item) => item.id === id)!
    expect(row.reason).toBe('user_excluded')
    expect(row.title).toMatch(/^记忆 · 记忆\d+：灵脉.*（fact · (confirmed|observed)）$/)
    expect(sentTitle).toMatch(/^fact · (confirmed|observed)$/)
    const overflowTitle = base.metadata.overflow![0].items[0].title
    const sameFormat = /^记忆 · .+（fact · (confirmed|observed)）$/
    expect(overflowTitle).toMatch(sameFormat); expect(row.title).toMatch(sameFormat)
  })

  it('切换对话后排除与钉住两组都重置；请求后只清空发出那组的排除', () => {
    const excl = { chat: ['a'], consistency: ['b'] }
    expect(updatePinsByScope(excl, 'chat', () => [])).toEqual({ chat: [], consistency: ['b'] })
    expect(emptyPinsByScope()).toEqual({ chat: [], consistency: [] })
  })
})
