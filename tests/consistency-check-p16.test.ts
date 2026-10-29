import { describe, expect, it } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ChatService } from '../src/main/services/chat-service'
import { ContextEngine } from '../src/main/ai/context-engine'
import { ProviderService, type ProviderMessage } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { composeProviderMessages } from '../src/main/ai/prompt-composer'
import { PromptTemplateService } from '../src/main/services/prompt-template-service'
import { aiStartSchema, chapterWordRangeSchema, promptTemplateTextSchema } from '../src/main/ipc/schemas'
import { toUserFacingIpcError } from '../src/main/ipc/validation-error'
import { CONSISTENCY_OUTPUT_CONTRACT, parseConsistencyReport } from '../src/shared/consistency-check'
import { READER_REVIEW_DEFAULT_INTENT } from '../src/shared/reader-review'
import { inputForQuickMode, inputForReaderThrough } from '../src/renderer/src/services/quick-mode-input'
import type { AIMode, ContextBundle } from '../src/shared/domain'

const REPORT = JSON.stringify({ conflicts: [{ quote: '林舟左手持剑', location: '第1段', conflictWith: { kind: 'character', title: '林舟' }, explanation: '人物卡写明林舟惯用右手' }] })

const setup = (chapterText = '林舟左手持剑，于腊月初七抵达京城。') => {
  const db = createTestDb()
  const project = new ProjectService(db).create({ title: '一致性', projectType: 'novel' })
  const docs = new DocumentService(db)
  const volume = docs.listTree(project.id).find((node) => node.type === 'volume')!
  const current = docs.listOrderedChapters(project.id)[0]
  const otherChapter = docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: '别章' })
  docs.saveContent({ projectId: project.id, documentId: current.id, editorJson: { type: 'doc' }, plainText: chapterText })
  docs.saveContent({ projectId: project.id, documentId: otherChapter.id, editorJson: { type: 'doc' }, plainText: '别章正文秘密' })
  const now = Date.now()
  db.raw.prepare(`INSERT INTO characters(id,project_id,name,aliases_json,notes,fields_json,created_at,updated_at) VALUES ('ch1',?,'林舟','[]','惯用右手','{}',?,?)`).run(project.id, now, now)
  db.raw.prepare(`INSERT INTO timeline_events(id,project_id,story_time_label,sort_key,title,chapter_id,character_ids_json,created_at,updated_at) VALUES ('t1',?,'腊月初九',1,'林舟抵达京城',NULL,'[]',?,?)`).run(project.id, now, now)
  const memories = new MemoryService(db)
  const confirmed = memories.create({ projectId: project.id, type: 'fact', content: '已确认设定：京城冬季封城', status: 'suggested', sourceType: 'author', sourceId: 'a' })
  memories.confirm(project.id, confirmed.id, 'user')
  memories.create({ projectId: project.id, type: 'fact', content: '待确认记忆秘密', status: 'suggested', sourceType: 'author', sourceId: 'a' })
  memories.create({ projectId: project.id, type: 'fact', content: '暂定记忆秘密', status: 'tentative', sourceType: 'author', sourceId: 'a' })
  memories.create({ projectId: project.id, type: 'foreshadowing', content: '待确认伏笔秘密', status: 'suggested', sourceType: 'chapter', sourceId: current.id })
  const other = new ProjectService(db).create({ title: '他书', projectType: 'novel' })
  docs.saveContent({ projectId: other.id, documentId: docs.listOrderedChapters(other.id)[0].id, editorJson: { type: 'doc' }, plainText: '他书正文秘密' })
  db.raw.prepare(`INSERT INTO timeline_events(id,project_id,story_time_label,sort_key,title,chapter_id,character_ids_json,created_at,updated_at) VALUES ('t2',?,'',1,'他书时间线秘密',NULL,'[]',?,?)`).run(other.id, now, now)
  return { db, project, chapterId: current.id }
}
const SECRETS = ['别章正文秘密', '待确认记忆秘密', '暂定记忆秘密', '待确认伏笔秘密', '他书正文秘密', '他书时间线秘密']
const task = (projectId: string, documentId: string | undefined, mode: AIMode = 'consistency_check') =>
  ({ mode, writePermission: 'none' as const, userIntent: '检查一致性', projectId, documentId })
const runtimeWith = (db: ReturnType<typeof createTestDb>, reply = REPORT, contextWindow?: number) => {
  const providers = new ProviderService(db, testCodec)
  providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'mock', baseUrl: 'http://localhost:11434/v1', apiKey: '' })
  providers.saveModel({ id: 'm', providerId: 'p', modelId: 'mock', displayName: 'mock', enabled: true, isDefault: true, contextWindow, maxOutput: contextWindow ? 64 : undefined,
    capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
  const sent: ProviderMessage[][] = []
  const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function* (input: { messages: ProviderMessage[] }) { sent.push(input.messages); yield reply } }))
  return { runtime, sent }
}

describe('P1-6 consistency_check context', () => {
  it('includes this chapter + confirmed settings, characters, timeline only', () => {
    const { db, project, chapterId } = setup()
    const bundle = new ContextEngine(db).build(task(project.id, chapterId))
    expect(bundle.policy).toBe('consistency')
    expect(bundle.items[0]).toMatchObject({ id: chapterId, kind: 'document' })
    expect(new Set(bundle.items.map((item) => item.kind))).toEqual(new Set(['document', 'memory', 'character', 'timeline']))
    const serialized = JSON.stringify(bundle)
    for (const expected of ['林舟左手持剑', '已确认设定：京城冬季封城', '惯用右手', '林舟抵达京城', '腊月初九']) expect(serialized).toContain(expected)
    for (const secret of SECRETS) expect(serialized).not.toContain(secret)
  })

  it('requires the current chapter', () => {
    const { db, project } = setup()
    expect(() => new ContextEngine(db).build(task(project.id, undefined))).toThrow('请先打开要检查的章节')
  })

  it('timeline stays out of every other mode', () => {
    const { db, project, chapterId } = setup('林舟抵达京城，林舟腊月初九。')
    const engine = new ContextEngine(db)
    for (const mode of ['discussion', 'brainstorm', 'generation', 'editing', 'organization', 'chapter_digest', 'proofreading'] as AIMode[]) {
      const bundle = engine.build({ ...task(project.id, chapterId, mode), userIntent: '林舟抵达京城 腊月初九 时间线' })
      expect(bundle.items.some((item) => item.kind === 'timeline'), mode).toBe(false)
      expect(JSON.stringify(bundle.items), mode).not.toContain('故事时间：')
    }
    const reader = engine.build({ ...task(project.id, undefined, 'reader_review'), throughChapterNumber: 2 })
    expect(reader.items.some((item) => item.kind === 'timeline')).toBe(false)
  })
})

describe('P1-6 consistency_check runtime + storage', () => {
  it('wire = manifest = snapshot; read-only; organization route; contract fixed even with template override', async () => {
    const { db, project, chapterId } = setup()
    new PromptTemplateService(db).set(project.id, 'consistency_check', '你是{{role}}，请严格。')
    const { runtime, sent } = runtimeWith(db)
    const thread = new ChatService(db).createThread(project.id, '检查')
    const before = { contents: db.raw.prepare('SELECT document_id, plain_text, revision FROM document_contents ORDER BY document_id').all(),
      memories: db.raw.prepare('SELECT id, status FROM memories ORDER BY id').all(), timeline: db.raw.prepare('SELECT * FROM timeline_events ORDER BY id').all() }
    const chunks: Array<{ context?: ContextBundle; candidates?: string[] }> = []
    for await (const chunk of runtime.run('r1', task(project.id, chapterId), thread.id, 'u1', 'a1')) chunks.push(chunk)
    const context = chunks.find((chunk) => chunk.context)!.context!
    const wire = JSON.stringify(sent[0])
    for (const item of context.items) expect(wire).toContain(item.content)
    for (const secret of SECRETS) expect(wire).not.toContain(secret)
    expect(sent[0][0].content).toContain(CONSISTENCY_OUTPUT_CONTRACT)
    expect(sent[0][0].content).toContain('你是记录员·一致性检查，请严格。')
    expect(sent[0][0].content).toContain('写入权限：none')
    expect(sent[0].filter((message) => message.role !== 'system')).toEqual([{ role: 'user', content: '检查一致性' }])
    const row = db.raw.prepare("SELECT content, task_mode, context_snapshot_json FROM chat_messages WHERE id = 'a1'").get() as { content: string; task_mode: string; context_snapshot_json: string }
    expect(row.task_mode).toBe('consistency_check')
    expect(row.content).toBe(REPORT)
    const snapshot = JSON.parse(row.context_snapshot_json) as { sources: Array<{ id: string; kind: string }>; target?: unknown }
    expect(snapshot.sources.map((source) => source.id)).toEqual(context.items.map((item) => item.id))
    expect(snapshot.target).toBeUndefined()
    expect(chunks.some((chunk) => chunk.candidates)).toBe(false)
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM text_patches').get() as { n: number }).n).toBe(0)
    expect(db.raw.prepare('SELECT document_id, plain_text, revision FROM document_contents ORDER BY document_id').all()).toEqual(before.contents)
    expect(db.raw.prepare('SELECT id, status FROM memories ORDER BY id').all()).toEqual(before.memories)
    expect(db.raw.prepare('SELECT * FROM timeline_events ORDER BY id').all()).toEqual(before.timeline)
  })

  it('report parsing: valid JSON, fenced JSON, and fallback to raw text', () => {
    const parsed = parseConsistencyReport(REPORT, '林舟左手持剑，于腊月初七抵达京城。')
    expect(parsed).toMatchObject({ ok: true, conflicts: [{ quote: '林舟左手持剑', location: '第1段', conflictWith: { kind: 'character', title: '林舟' }, quoteFound: true }] })
    expect(parseConsistencyReport('```json\n{"conflicts":[]}\n```')).toEqual({ ok: true, conflicts: [] })
    for (const bad of ['我觉得没问题', '{"conflicts":[{"quote":""}]}', '{not json}', '{"conflicts":[{"quote":"x","conflictWith":{"kind":"plot","title":"t"}}]}'])
      expect(parseConsistencyReport(bad)).toEqual({ ok: false, raw: bad })
  })
})

describe('fix 1: quick mode never overwrites author text; reader N stays in sync', () => {
  it('keeps typed text and swaps only default intents', () => {
    expect(inputForQuickMode('reader_review', '我自己写的问题', '3')).toBe('我自己写的问题')
    expect(inputForQuickMode('generation', '我自己写的问题', '3')).toBe('我自己写的问题')
    expect(inputForQuickMode('reader_review', '', '3')).toBe(READER_REVIEW_DEFAULT_INTENT(3))
    expect(inputForQuickMode('discussion', READER_REVIEW_DEFAULT_INTENT(3), '3')).toBe('')
    expect(inputForQuickMode('reader_review', '请根据当前上下文生成一段候选文字。', '2')).toBe(READER_REVIEW_DEFAULT_INTENT(2))
    expect(inputForReaderThrough(READER_REVIEW_DEFAULT_INTENT(3), '7')).toBe(READER_REVIEW_DEFAULT_INTENT(7))
    expect(inputForReaderThrough('读到第 3 章的我有话说', '7')).toBe('读到第 3 章的我有话说')
    expect(inputForQuickMode('reader_review', READER_REVIEW_DEFAULT_INTENT(3), '5')).toBe(READER_REVIEW_DEFAULT_INTENT(5))
  })
})

describe('fix 2: zod Chinese errors keep the concrete reason', () => {
  const message = (schema: { safeParse(value: unknown): { success: boolean; error?: unknown } }, value: unknown): string => {
    const result = schema.safeParse(value)
    expect(result.success).toBe(false)
    const error = toUserFacingIpcError(result.error) as Error & { code?: string }
    expect(error.code).toBe('IPC_INVALID_INPUT')
    expect(error.message).not.toContain('（整体）')
    expect(error.message).not.toMatch(/[{[]"/)
    return error.message
  }
  it('unknown variable, too long, min>max, illegal mode', () => {
    expect(message(promptTemplateTextSchema, '你好{{foo}}')).toContain('未知变量：{{foo}}')
    expect(message(promptTemplateTextSchema, 'x'.repeat(5000))).toMatch(/超过长度上限 4000 字/)
    expect(message(chapterWordRangeSchema, { min: 5000, max: 100 })).toContain('字数下限不能大于上限')
    expect(message(chapterWordRangeSchema, { min: -1, max: null })).toContain('字数下限')
    expect(message(aiStartSchema, { requestId: 'r', threadId: 't', userMessageId: 'u', assistantMessageId: 'a',
      task: { mode: 'nope', writePermission: 'none', userIntent: 'x', projectId: 'p' } })).toMatch(/模式（task\.mode）：取值无效，可选：.*consistency_check/)
  })
})

describe('fix 3: wire text carries 已省略/已截断; snapshot records truncation', () => {
  it('composer annotates truncated and omitted items', () => {
    const context: ContextBundle = { projectId: 'p', policy: 'creative', items: [{ id: 'c1', kind: 'document', title: '第一章', content: '开头', projectId: 'p', reason: 'r', truncated: true }],
      metadata: { estimatedTokens: 1, sourceIds: ['c1'], excludedKinds: [], omitted: [{ id: 'c2', kind: 'nearby', title: '第二章', reason: 'budget' }, { id: 'x', kind: 'memory', title: '作者排除', reason: 'user_excluded' }] } }
    const wire = composeProviderMessages({ task: task('p', 'c1', 'discussion'), context, history: [] })[1].content
    expect(wire).toContain('第一章（已截断，部分已省略）\n开头')
    expect(wire).toContain('[已省略] 因超出预算未发送：第二章')
    expect(wire).not.toContain('作者排除')
  })

  it('truncation keeps one contiguous end and snapshot marks the truncated chapter', async () => {
    const chapter = '林舟左手持剑。'.repeat(600)
    const { db, project, chapterId } = setup(chapter)
    const { runtime, sent } = runtimeWith(db, REPORT, 1200)
    const thread = new ChatService(db).createThread(project.id, '小窗口')
    const chunks: Array<{ context?: ContextBundle }> = []
    for await (const chunk of runtime.run('r2', task(project.id, chapterId), thread.id, 'u2', 'a2')) chunks.push(chunk)
    const context = chunks.find((chunk) => chunk.context)!.context!
    const sentChapter = context.items.find((item) => item.id === chapterId)!
    expect(sentChapter.truncated).toBe(true)
    expect(chapter.startsWith(sentChapter.content) || chapter.endsWith(sentChapter.content)).toBe(true)
    expect(JSON.stringify(sent[0])).toContain('（已截断，部分已省略）')
    const snapshot = JSON.parse((db.raw.prepare("SELECT context_snapshot_json FROM chat_messages WHERE id = 'a2'").get() as { context_snapshot_json: string }).context_snapshot_json) as { sources: Array<{ id: string; truncated?: boolean }>; omitted: Array<{ id: string }> }
    expect(snapshot.sources.find((source) => source.id === chapterId)).toMatchObject({ truncated: true })
    if (context.metadata.omitted?.length) expect(JSON.stringify(sent[0])).toContain('[已省略]')
  })
})
