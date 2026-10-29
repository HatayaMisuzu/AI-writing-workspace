import { describe, expect, it } from 'vitest'
import { ZodError, z } from 'zod'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ChatService } from '../src/main/services/chat-service'
import { ContextEngine } from '../src/main/ai/context-engine'
import { ProviderService, type ProviderMessage } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { aiStartSchema } from '../src/main/ipc/schemas'
import { toUserFacingIpcError } from '../src/main/ipc/validation-error'
import { validateReaderChapterNumber } from '../src/shared/reader-review'
import { DEFAULT_PROMPT_TEMPLATES } from '../src/shared/prompt-templates'
import { omittedLabel, toContextSourceRows } from '../src/renderer/src/services/context-sources'

const setup = (chapterText = (i: number) => `第${i}章正文：雨夜线索${i}。`) => {
  const db = createTestDb()
  const project = new ProjectService(db).create({ title: '读者审稿', projectType: 'novel' })
  const docs = new DocumentService(db)
  const volume = docs.listTree(project.id).find((node) => node.type === 'volume')!
  const first = docs.listOrderedChapters(project.id)[0]
  const ids = [first.id]
  for (let i = 2; i <= 4; i += 1) ids.push(docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: `章${i}` }).id)
  ids.forEach((id, index) => docs.saveContent({ projectId: project.id, documentId: id, editorJson: { type: 'doc' }, plainText: chapterText(index + 1) }))
  // 设定 / 大纲 / 人物 / 时间线 / 伏笔 / 记忆 —— 一律不得进入读者上下文
  const now = Date.now()
  db.raw.prepare(`INSERT INTO characters(id,project_id,name,aliases_json,notes,fields_json,created_at,updated_at) VALUES ('ch1',?,'雨夜','[]','人物卡秘密：雨夜是凶手','{}',?,?)`).run(project.id, now, now)
  db.raw.prepare(`INSERT INTO project_notes(id,project_id,section,title,content,created_at,updated_at) VALUES ('n1',?,'story','雨夜设定','设定秘密：线索是假的',?,?)`).run(project.id, now, now)
  db.raw.prepare(`INSERT INTO project_notes(id,project_id,section,title,content,created_at,updated_at) VALUES ('n2',?,'outline','大纲','大纲秘密：结局反转',?,?)`).run(project.id, now, now)
  db.raw.prepare(`INSERT INTO node_outlines(node_id,project_id,summary,beats_json,hook,updated_at) VALUES (?,?,'细纲秘密：第二章埋伏','[]','',?)`).run(ids[1], project.id, now)
  db.raw.prepare(`INSERT INTO timeline_events(id,project_id,story_time_label,sort_key,title,chapter_id,character_ids_json,created_at,updated_at) VALUES ('t1',?,'',1,'时间线秘密：三年前',NULL,'[]',?,?)`).run(project.id, now, now)
  const memories = new MemoryService(db)
  const secret = memories.create({ projectId: project.id, type: 'fact', content: '记忆秘密：雨夜线索伪造', status: 'suggested', sourceType: 'author', sourceId: 'a' })
  memories.confirm(project.id, secret.id, 'user')
  memories.create({ projectId: project.id, type: 'foreshadowing', content: '伏笔秘密：红伞', status: 'observed', sourceType: 'chapter', sourceId: ids[0], readerVisibleFrom: 1 })
  const other = new ProjectService(db).create({ title: '他书', projectType: 'novel' })
  const otherChapter = docs.listOrderedChapters(other.id)[0]
  docs.saveContent({ projectId: other.id, documentId: otherChapter.id, editorJson: { type: 'doc' }, plainText: '他书正文秘密' })
  return { db, project, ids }
}
const SECRETS = ['人物卡秘密', '设定秘密', '大纲秘密', '细纲秘密', '时间线秘密', '记忆秘密', '伏笔秘密', '他书正文秘密']

const runtimeWith = (db: ReturnType<typeof createTestDb>, contextWindow?: number) => {
  const providers = new ProviderService(db, testCodec)
  providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'mock', baseUrl: 'http://localhost:11434/v1', apiKey: '' })
  providers.saveModel({ id: 'm', providerId: 'p', modelId: 'mock', displayName: 'mock', enabled: true, isDefault: true, contextWindow, maxOutput: contextWindow ? 64 : undefined,
    capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
  const sent: ProviderMessage[][] = []
  const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function* (input: { messages: ProviderMessage[] }) {
    sent.push(input.messages); yield '读者疑问：第 2 章的雨夜线索从何而来？\n追读风险：第 1 章节奏偏慢。'
  } }))
  return { runtime, sent }
}
const task = (projectId: string, n: unknown) => ({ mode: 'reader_review' as const, writePermission: 'none' as const, userIntent: '请审稿', projectId, throughChapterNumber: n as number })

describe('P1-5 reader_review', () => {
  it('context is strictly chapters 1..N in tree order; N+1 and settings never appear', () => {
    const { db, project, ids } = setup()
    const bundle = new ContextEngine(db).build(task(project.id, 2))
    expect(bundle.policy).toBe('reader')
    expect(bundle.items.map((item) => item.id)).toEqual([ids[0], ids[1]])
    expect(bundle.items.every((item) => item.kind === 'document')).toBe(true)
    const serialized = JSON.stringify(bundle)
    expect(serialized).toContain('雨夜线索2')
    expect(serialized).not.toContain('雨夜线索3')
    expect(serialized).not.toContain('雨夜线索4')
    for (const secret of SECRETS) expect(serialized).not.toContain(secret)
  })

  it('manifest = provider request = saved snapshot; report is read-only (no patch, no text/memory writes)', async () => {
    const { db, project, ids } = setup()
    const { runtime, sent } = runtimeWith(db)
    const thread = new ChatService(db).createThread(project.id, '审稿')
    const preview = runtime.previewContext(task(project.id, 3), thread.id)
    const before = { contents: db.raw.prepare('SELECT document_id, plain_text, revision FROM document_contents ORDER BY document_id').all(),
      memories: (db.raw.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n }
    const chunks: Array<{ context?: { items: Array<{ id: string }> }; candidates?: string[] }> = []
    for await (const chunk of runtime.run('req-1', task(project.id, 3), thread.id, 'u1', 'a1')) chunks.push(chunk)
    const streamed = chunks.find((chunk) => chunk.context)!.context!
    expect(streamed.items.map((item) => item.id)).toEqual(preview.items.map((item) => item.id))
    expect(preview.items.map((item) => item.id)).toEqual(ids.slice(0, 3))
    expect(sent).toHaveLength(1)
    const wire = JSON.stringify(sent[0])
    for (const item of preview.items) expect(wire).toContain(item.content)
    expect(wire).not.toContain('雨夜线索4')
    for (const secret of SECRETS) expect(wire).not.toContain(secret)
    expect(sent[0].filter((message) => message.role !== 'system')).toEqual([{ role: 'user', content: '请审稿' }])
    const row = db.raw.prepare("SELECT content, task_mode, context_snapshot_json FROM chat_messages WHERE id = 'a1'").get() as { content: string; task_mode: string; context_snapshot_json: string }
    expect(row.task_mode).toBe('reader_review')
    expect(row.content).toContain('读者疑问')
    expect((JSON.parse(row.context_snapshot_json) as { sources: Array<{ id: string }> }).sources.map((source) => source.id)).toEqual(ids.slice(0, 3))
    expect(chunks.some((chunk) => chunk.candidates)).toBe(false)
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM text_patches').get() as { n: number }).n).toBe(0)
    expect(db.raw.prepare('SELECT document_id, plain_text, revision FROM document_contents ORDER BY document_id').all()).toEqual(before.contents)
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(before.memories)
    expect(sent[0][0].content).toContain('写入权限：none')
    expect(DEFAULT_PROMPT_TEMPLATES.reader_review).toMatch(/读者疑问.*追读风险/)
  })

  it('N boundaries: <1, out of range and non-integer are rejected with Chinese errors', () => {
    expect(validateReaderChapterNumber(1, 4)).toEqual({ ok: true, index: 0 })
    expect(validateReaderChapterNumber(4, 4)).toEqual({ ok: true, index: 3 })
    expect(validateReaderChapterNumber(0, 4)).toMatchObject({ ok: false, error: expect.stringContaining('至少为 1') })
    expect(validateReaderChapterNumber(-1, 4)).toMatchObject({ ok: false })
    expect(validateReaderChapterNumber(5, 4)).toMatchObject({ ok: false, error: expect.stringContaining('共 4 章') })
    expect(validateReaderChapterNumber(1.5, 4)).toMatchObject({ ok: false, error: expect.stringContaining('整数') })
    expect(validateReaderChapterNumber(Number.NaN, 4)).toMatchObject({ ok: false })
    expect(validateReaderChapterNumber('2', 4)).toMatchObject({ ok: false })
    const { db, project } = setup()
    const engine = new ContextEngine(db)
    for (const n of [0, 5, 2.5]) expect(() => engine.build(task(project.id, n))).toThrow(/第 N 章/)
    expect(() => engine.build({ ...task(project.id, 1), throughChapterNumber: undefined })).toThrow('READER_CHAPTER_REQUIRED')
  })

  it('over-budget chapters are cut per S7 and annotated 已省略 in the manifest, never silently dropped', () => {
    const { db, project, ids } = setup((i) => `第${i}章`.padEnd(400, '雨'))
    const bundle = new ContextEngine(db).build(task(project.id, 4), 300)
    const listed = [...bundle.items.map((item) => item.id), ...(bundle.metadata.omitted ?? []).map((item) => item.id)]
    expect(new Set(listed)).toEqual(new Set(ids))
    expect(bundle.items.at(-1)!.id).toBe(ids[3])
    expect(bundle.metadata.omitted!.length).toBeGreaterThan(0)
    const rows = toContextSourceRows(bundle)
    expect(rows.filter((row) => !row.included).every((row) => omittedLabel(row.omittedReason).includes('已省略'))).toBe(true)
  })

  it('runtime final fit on a tiny window still annotates and keeps manifest = wire', async () => {
    const { db, project, ids } = setup((i) => `第${i}章`.padEnd(600, '雨'))
    const { runtime, sent } = runtimeWith(db, 1200)
    const thread = new ChatService(db).createThread(project.id, '小窗口')
    const chunks: Array<{ context?: { items: Array<{ id: string; content: string }>; metadata: { omitted?: Array<{ id: string; reason: string }> } } }> = []
    for await (const chunk of runtime.run('req-2', task(project.id, 4), thread.id, 'u2', 'a2')) chunks.push(chunk)
    const context = chunks.find((chunk) => chunk.context)!.context!
    expect(context.items.at(-1)!.id).toBe(ids[3])
    const accounted = new Set([...context.items.map((item) => item.id), ...(context.metadata.omitted ?? []).map((item) => item.id)])
    expect(accounted).toEqual(new Set(ids))
    expect(context.metadata.omitted!.every((item) => item.reason === 'budget')).toBe(true)
    for (const item of context.items) expect(JSON.stringify(sent[0])).toContain(item.content)
    const snapshot = JSON.parse((db.raw.prepare("SELECT context_snapshot_json FROM chat_messages WHERE id = 'a2'").get() as { context_snapshot_json: string }).context_snapshot_json) as { sources: Array<{ id: string }>; omitted: Array<{ id: string }> }
    expect(snapshot.sources.map((source) => source.id)).toEqual(context.items.map((item) => item.id))
    expect(snapshot.omitted.map((item) => item.id).sort()).toEqual((context.metadata.omitted ?? []).map((item) => item.id).sort())
  })
})

describe('hygiene: IPC zod rejection is readable Chinese', () => {
  it('maps ZodError to a short Chinese message without JSON', () => {
    const result = aiStartSchema.safeParse({ requestId: 'r', threadId: 't', userMessageId: 'u', assistantMessageId: 'a', task: { mode: 'nope' } })
    expect(result.success).toBe(false)
    const error = toUserFacingIpcError(result.error) as Error & { code?: string }
    expect(error.code).toBe('IPC_INVALID_INPUT')
    expect(error.message).toMatch(/^请求参数无效：/)
    expect(error.message).toContain('task.mode')
    expect(error.message).not.toMatch(/[[{]"/)
    expect(toUserFacingIpcError(new ZodError(z.string().safeParse(1).error!.issues))).toBeInstanceOf(Error)
    const plain = new Error('READER_CHAPTER_REQUIRED')
    expect(toUserFacingIpcError(plain)).toBe(plain)
  })
})
