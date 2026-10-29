import { describe, expect, it } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ChatService } from '../src/main/services/chat-service'
import { ProviderService, type ProviderMessage } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { compareSettingRank, memoryEntryNames, rankSetting, settingBasis } from '../src/shared/setting-order'
import { basisLabel, toContextSourceRows } from '../src/renderer/src/services/context-sources'
import type { AIMode, AITaskEnvelope, ContextBundle } from '../src/shared/domain'

const REPORT = JSON.stringify({ conflicts: [] })
const RELEVANT = ['灵脉', '赤霄剑', '青岚宗']
const FILLER = ['杂项甲', '杂项乙', '杂项丙', '杂项丁', '杂项戊', '杂项己', '杂项庚', '杂项辛', '杂项壬']
const longBody = (name: string): string => `${name}：${'这是一段很长的设定描述，用来占满上下文预算。'.repeat(28)}`

/** 12 条长设定：3 条与本章相关（较旧），9 条填充（较新，改前会因「最近更新」排在前面而挤掉相关设定）。 */
const setup = (opts: { long?: boolean; mention?: boolean; status?: (name: string) => 'confirmed' | 'observed' } = {}) => {
  const { long = true, mention = true, status = () => 'confirmed' as const } = opts
  const db = createTestDb()
  const project = new ProjectService(db).create({ title: '排序', projectType: 'novel' })
  const docs = new DocumentService(db)
  const chapter = docs.listOrderedChapters(project.id)[0]
  docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' },
    plainText: mention ? '林舟握紧赤霄剑，感到灵脉翻涌，青岚宗的钟声传来。' : '林舟独自走在雪夜里。' })
  const memories = new MemoryService(db)
  const ids: Record<string, string> = {}
  ;[...RELEVANT, ...FILLER].forEach((name, index) => {
    const content = long ? longBody(name) : `${name}：短设定。`
    const created = memories.create({ projectId: project.id, type: 'fact', content, status: 'suggested', sourceType: 'author', sourceId: 'a' })
    if (status(name) === 'confirmed') memories.confirm(project.id, created.id, 'user')
    else db.raw.prepare("UPDATE memories SET status = 'observed' WHERE id = ?").run(created.id)
    db.raw.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(1_000 + index, created.id)
    ids[name] = created.id
  })
  return { db, project, chapterId: chapter.id, ids }
}

const runtimeWith = (db: ReturnType<typeof createTestDb>, contextWindow?: number) => {
  const providers = new ProviderService(db, testCodec)
  providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'mock', baseUrl: 'http://localhost:11434/v1', apiKey: '' })
  providers.saveModel({ id: 'm', providerId: 'p', modelId: 'mock', displayName: 'mock', enabled: true, isDefault: true, contextWindow, maxOutput: contextWindow ? 64 : undefined,
    capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
  const sent: ProviderMessage[][] = []
  let calls = 0
  const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function* (input: { messages: ProviderMessage[] }) { calls += 1; sent.push(input.messages); yield REPORT } }))
  return { runtime, sent, calls: () => calls }
}

const task = (projectId: string, documentId: string, mode: AIMode = 'consistency_check', extra: Partial<AITaskEnvelope> = {}): AITaskEnvelope =>
  ({ mode, writePermission: mode === 'editing' || mode === 'generation' ? 'proposal' : 'none', userIntent: mode === 'consistency_check' ? '检查一致性' : '这些设定怎么用', projectId, documentId, ...extra })

const runOnce = async (runtime: AICreativeRuntime, db: ReturnType<typeof createTestDb>, t: AITaskEnvelope, tag: string) => {
  const thread = new ChatService(db).createThread(t.projectId, tag)
  const chunks: Array<{ context?: ContextBundle }> = []
  for await (const chunk of runtime.run(`r-${tag}`, t, thread.id, `u-${tag}`, `a-${tag}`)) chunks.push(chunk)
  const context = chunks.find((chunk) => chunk.context)!.context!
  const row = db.raw.prepare('SELECT context_snapshot_json FROM chat_messages WHERE id = ?').get(`u-${tag}`) as { context_snapshot_json: string | null } | undefined
    ?? db.raw.prepare('SELECT context_snapshot_json FROM chat_messages WHERE id = ?').get(`a-${tag}`) as { context_snapshot_json: string | null }
  return { context, snapshot: JSON.parse(row.context_snapshot_json ?? '{}') as { sources: Array<{ id: string; basis?: string[] }>; omitted: Array<{ id: string; reason: string; basis?: string[] }> } }
}

describe('P3-e setting-order rules (pure)', () => {
  it('pinned > confirmed > mentioned > updatedAt desc > id asc', () => {
    const r = (id: string, o: Partial<{ pinned: boolean; confirmed: boolean; names: string[]; updatedAt: number }>) =>
      rankSetting({ id, pinned: false, confirmed: false, names: [], updatedAt: 0, ...o }, '本章提到灵脉')
    const list = [r('e', { updatedAt: 5 }), r('d', { updatedAt: 9 }), r('c', { names: ['灵脉'] }), r('b', { confirmed: true }), r('a', { pinned: true }), r('f', { updatedAt: 5 })]
    expect(list.toSorted(compareSettingRank).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(settingBasis(r('x', { pinned: true, confirmed: true, names: ['灵脉'] }))).toEqual(['钉住', '已确认', '本章提及'])
    expect(settingBasis(r('y', {}))).toEqual(['按最近更新'])
    expect(memoryEntryNames('赤霄剑：上古名剑')).toEqual(['赤霄剑'])
    expect(memoryEntryNames('没有冒号的一句话设定')).toEqual([])
  })
})

describe('P3-e consistency_check: 12 long settings', () => {
  for (const window of [3000, 1600]) {
    it(`window ${window}: chapter-mentioned confirmed settings kept, fillers omitted first; wire = preview = snapshot`, async () => {
      const { db, project, chapterId, ids } = setup()
      const { runtime, sent, calls } = runtimeWith(db, window)
      const preview = runtime.previewContext(task(project.id, chapterId), 'none')
      const { context, snapshot } = await runOnce(runtime, db, task(project.id, chapterId), `w${window}`)
      expect(calls()).toBe(1)
      const sentIds = context.items.filter((item) => item.kind === 'memory').map((item) => item.id)
      for (const name of RELEVANT) expect(sentIds).toContain(ids[name])
      // 省略的都是填充；任何被省略的填充都不早于入选的相关设定
      const omitted = (context.metadata.omitted ?? []).filter((item) => item.kind === 'memory')
      expect(omitted.length).toBeGreaterThan(0)
      expect(omitted.every((item) => FILLER.some((name) => ids[name] === item.id))).toBe(true)
      expect(sentIds.slice(0, 3)).toEqual(RELEVANT.toReversed().map((name) => ids[name]))
      // 实际发送内容 = 清单 = snapshot
      const wire = JSON.stringify(sent[0])
      for (const item of context.items) expect(wire).toContain(item.content.slice(0, 20))
      for (const item of omitted) expect(wire).not.toContain(longBody(FILLER.find((name) => ids[name] === item.id)!).slice(0, 24))
      expect(preview.items.map((item) => item.id)).toEqual(context.items.map((item) => item.id))
      expect(snapshot.sources.map((item) => item.id)).toEqual(context.items.map((item) => item.id))
      expect(snapshot.sources.find((item) => item.id === ids['灵脉'])!.basis).toEqual(['已确认', '本章提及'])
      const omittedSnap = snapshot.omitted.find((item) => item.id === omitted[0].id)!
      expect(omittedSnap).toMatchObject({ reason: 'budget', basis: ['已确认', '预算不足省略'] })
      const rows = toContextSourceRows(preview)
      expect(basisLabel(rows.find((row) => row.id === ids['赤霄剑'])!)).toBe('已确认 · 本章提及')
      expect(basisLabel(rows.find((row) => row.id === omitted[0].id)!)).toBe('已确认 · 预算不足省略')
    })
  }

  it('pinned filler is always first and kept; basis shows 钉住', () => {
    const { db, project, chapterId, ids } = setup()
    const { runtime } = runtimeWith(db, 1600)
    const bundle = runtime.previewContext(task(project.id, chapterId, 'consistency_check', { includedIds: [ids['杂项甲']] }), 'none')
    expect(bundle.items[0].id).toBe(ids['杂项甲'])
    expect(bundle.items[0].basis).toEqual(['钉住', '已确认'])
  })

  it('deterministic: same input → same output', () => {
    const a = setup(); const b = runtimeWith(a.db, 3000)
    const first = JSON.stringify(b.runtime.previewContext(task(a.project.id, a.chapterId), 'none'))
    const second = JSON.stringify(b.runtime.previewContext(task(a.project.id, a.chapterId), 'none'))
    expect(second).toBe(first)
  })

  it('short settings + big window: everything sent, same order as before (updated_at desc), no omissions', () => {
    const { db, project, chapterId, ids } = setup({ long: false, mention: false })
    const { runtime } = runtimeWith(db)
    const bundle = runtime.previewContext(task(project.id, chapterId), 'none')
    expect(bundle.metadata.omitted ?? []).toEqual([])
    expect(bundle.items.filter((item) => item.kind === 'memory').map((item) => item.id)).toEqual([...RELEVANT, ...FILLER].toReversed().map((name) => ids[name]))
    expect(bundle.items.every((item) => !item.truncated)).toBe(true)
  })
})

describe('P3-e creative modes', () => {
  it('discussion, window 1600: confirmed beats observed even if observed is mentioned; mentioned confirmed beat newer fillers', () => {
    // 灵脉 observed（被提及），其余 confirmed
    const { db, project, chapterId, ids } = setup({ status: (name) => name === '灵脉' ? 'observed' : 'confirmed' })
    const { runtime } = runtimeWith(db, 1600)
    const bundle = runtime.previewContext(task(project.id, chapterId, 'discussion'), 'none')
    const memIds = bundle.items.filter((item) => item.kind === 'memory').map((item) => item.id)
    expect(memIds[0]).toBe(ids['青岚宗'])
    expect(memIds[1]).toBe(ids['赤霄剑'])
    expect(memIds).not.toContain(ids['灵脉'])
    expect(bundle.items.find((item) => item.id === ids['赤霄剑'])!.basis).toEqual(['已确认', '本章提及'])
  })

  it('selection mention counts as 本章相关', () => {
    const { db, project, chapterId, ids } = setup({ mention: false })
    const { runtime } = runtimeWith(db, 1600)
    const bundle = runtime.previewContext(task(project.id, chapterId, 'discussion', { selection: { from: 1, to: 3, text: '赤霄剑' } }), 'none')
    expect(bundle.items.filter((item) => item.kind === 'memory')[0].id).toBe(ids['赤霄剑'])
  })

  it('pinned memory comes right after selection in creative modes, even if not keyword-relevant', () => {
    const { db, project, chapterId, ids } = setup()
    db.raw.prepare("UPDATE memories SET content = '冷门：与本问题无关' WHERE id = ?").run(ids['杂项乙'])
    const { runtime } = runtimeWith(db, 3000)
    const bundle = runtime.previewContext(task(project.id, chapterId, 'generation', { includedIds: [ids['杂项乙']] }), 'none')
    expect(bundle.items[0].id).toBe(ids['杂项乙'])
    expect(bundle.items[0].basis).toEqual(['钉住', '已确认'])
  })

  it('no extra API calls: preview makes none, run makes exactly one per mode', async () => {
    for (const mode of ['discussion', 'organization', 'editing', 'proofreading'] as AIMode[]) {
      const { db, project, chapterId } = setup()
      const { runtime, calls } = runtimeWith(db, 3000)
      runtime.previewContext(task(project.id, chapterId, mode), 'none')
      expect(calls()).toBe(0)
      await runOnce(runtime, db, task(project.id, chapterId, mode), mode)
      expect(calls()).toBe(1)
    }
  })
})

describe('P3-e M1: rank all candidates before applying limits', () => {
  const many = (count: number, mode: 'confirmed-only' | 'creative') => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '长篇', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '林舟回到了旧城。' })
    const memories = new MemoryService(db)
    const make = (content: string, updatedAt: number): string => {
      const created = memories.create({ projectId: project.id, type: 'fact', content, status: 'suggested', sourceType: 'author', sourceId: 'a' })
      memories.confirm(project.id, created.id, 'user')
      db.raw.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(updatedAt, created.id)
      return created.id
    }
    const oldRelevant = make(mode === 'creative' ? '林舟：设定 MARK_OLD_RELEVANT' : '林舟：MARK_OLD_RELEVANT 左手有疤', 1)
    for (let i = 0; i < count - 1; i += 1) make(`杂项${String(i).padStart(2, '0')}：${mode === 'creative' ? '设定 ' : ''}填充内容`, 100 + i)
    return { db, project, chapterId: chapter.id, oldRelevant }
  }

  it('consistency_check: 66 confirmed settings, the relevant one is the oldest → still selected and sent first', () => {
    const { db, project, chapterId, oldRelevant } = many(66, 'confirmed-only')
    const { runtime } = runtimeWith(db, 16000)
    const bundle = runtime.previewContext(task(project.id, chapterId), 'none')
    const mem = bundle.items.filter((item) => item.kind === 'memory')
    expect(mem.length).toBe(60)
    expect(mem[0].id).toBe(oldRelevant)
    expect(mem[0].basis).toEqual(['已确认', '本章提及'])
  })

  it('creative (discussion): 15 keyword-relevant memories, the chapter-mentioned one is oldest → kept within the 12 cap', () => {
    const { db, project, chapterId, oldRelevant } = many(15, 'creative')
    const { runtime } = runtimeWith(db, 16000)
    const bundle = runtime.previewContext(task(project.id, chapterId, 'discussion', { userIntent: '设定' }), 'none')
    const mem = bundle.items.filter((item) => item.kind === 'memory')
    expect(mem.length).toBe(12)
    expect(mem[0].id).toBe(oldRelevant)
  })
})

describe('P3-e M2: pin state within a conversation', () => {
  it('request completion keeps pins, clears exclusions and outline checks; switching conversation resets', async () => {
    const { stateAfterRequest, clearedExclusionState, contextButtonLabel, pinnedIdsOf, PIN_SCOPE_HINT } = await import('../src/renderer/src/services/context-sources')
    const state = { excludedIds: ['x1'], includedIds: ['outline:ch1', 'mem-1', 'outline-note:n1', 'char-2'] }
    const after = stateAfterRequest(state)
    expect(after).toEqual({ excludedIds: [], includedIds: ['mem-1', 'char-2'] })
    expect(stateAfterRequest(after)).toEqual(after) // 多次请求仍保留
    expect(clearedExclusionState()).toEqual({ excludedIds: [], includedIds: [] }) // 切换/新建对话重置
    expect(pinnedIdsOf(state.includedIds)).toEqual(['mem-1', 'char-2'])
    expect(contextButtonLabel(state.excludedIds, state.includedIds)).toBe('上下文（排除 1·勾选大纲 2·钉住 2）')
    expect(contextButtonLabel([], ['mem-1'])).toBe('上下文（钉住 1）')
    expect(contextButtonLabel([], ['outline:a'])).toBe('上下文（勾选大纲 1）')
    expect(contextButtonLabel([], [])).toBe('上下文')
    expect(PIN_SCOPE_HINT).toBe('钉住仅在本次对话有效')
  })

  it('pins kept after a request still drive the next request', async () => {
    const { db, project, chapterId, ids } = setup()
    const { runtime } = runtimeWith(db, 1600)
    const { stateAfterRequest } = await import('../src/renderer/src/services/context-sources')
    const first = task(project.id, chapterId, 'consistency_check', { includedIds: [ids['杂项甲']] })
    await runOnce(runtime, db, first, 'pin1')
    const kept = stateAfterRequest({ excludedIds: [], includedIds: first.includedIds! })
    const { context } = await runOnce(runtime, db, task(project.id, chapterId, 'consistency_check', { includedIds: kept.includedIds }), 'pin2')
    expect(context.items[0].id).toBe(ids['杂项甲'])
  })
})

describe('P3-e M3: creative memory cap keeps keyword relevance (incl. author question)', () => {
  const build = (fill: number, hirel = true) => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '相关度', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '雪夜无事。' })
    const memories = new MemoryService(db)
    const make = (content: string, updatedAt: number, status: 'confirmed' | 'observed' | 'tentative' = 'confirmed'): string => {
      const created = memories.create({ projectId: project.id, type: 'fact', content, status: 'suggested', sourceType: 'author', sourceId: 'a' })
      if (status === 'confirmed') memories.confirm(project.id, created.id, 'user')
      else db.raw.prepare('UPDATE memories SET status = ? WHERE id = ?').run(status, created.id)
      db.raw.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(updatedAt, created.id)
      return created.id
    }
    const hi = hirel ? make('MARK_HIREL：青铜古镜能照出前世，镜背刻有九尾狐纹', 1) : ''
    const fills = Array.from({ length: fill }, (_, i) => make(`r${String(i).padStart(2, '0')}：一件古物`, 100 + i, i % 3 === 0 ? 'observed' : i % 3 === 1 ? 'tentative' : 'confirmed'))
    return { db, project, chapterId: chapter.id, hi, fills, memories }
  }
  const intent = '青铜古镜照出前世的设定'

  it('MARK_HIREL (old, highly keyword-relevant via author question) is kept over 12 newer low-relevance confirmed', () => {
    const { db, project, chapterId, hi } = build(0)
    const memories = new MemoryService(db)
    for (let i = 0; i < 12; i += 1) {
      const created = memories.create({ projectId: project.id, type: 'fact', content: `r${i}：古物`, status: 'suggested', sourceType: 'author', sourceId: 'a' })
      memories.confirm(project.id, created.id, 'user')
      db.raw.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(100 + i, created.id)
    }
    const { runtime } = runtimeWith(db, 16000)
    const bundle = runtime.previewContext(task(project.id, chapterId, 'discussion', { userIntent: intent }), 'none')
    const mem = bundle.items.filter((item) => item.kind === 'memory')
    expect(mem.length).toBe(12)
    expect(mem.map((item) => item.id)).toContain(hi)
  })

  for (const count of [1, 5, 11]) {
    it(`≤12 relevant memories (${count + 1}, mixed status): selected set equals base selection (searchRelevant limit 12, unchanged b3bf091 code path)`, () => {
      const { db, project, chapterId, memories } = build(count)
      const { runtime } = runtimeWith(db, 16000)
      for (const mode of ['discussion', 'generation'] as AIMode[]) {
        const t = task(project.id, chapterId, mode, { userIntent: `${intent} 古物` })
        const bundle = runtime.previewContext(t, 'none')
        const sentSet = new Set(bundle.items.filter((item) => item.kind === 'memory').map((item) => item.id))
        // base（b3bf091）的创作类记忆入选 = searchRelevant(statuses, signal) 默认 limit 12；该函数本 PR 未改动
        const signal = [t.userIntent, '', '雪夜无事。'].filter(Boolean).join('\n')
        const base = new Set(memories.searchRelevant(project.id, ['confirmed', 'observed', 'tentative', 'idea'], signal).map((memory) => memory.id))
        expect(sentSet).toEqual(base)
      }
    })
  }
})
