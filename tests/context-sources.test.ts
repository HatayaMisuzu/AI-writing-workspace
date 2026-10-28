import { describe, expect, it } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ChatService } from '../src/main/services/chat-service'
import { ContextEngine } from '../src/main/ai/context-engine'
import { ProviderService, type ProviderMessage } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { aiPreviewContextSchema, aiStartSchema } from '../src/main/ipc/schemas'
import { isRowChecked, toContextSourceRows, toggleExcludedId } from '../src/renderer/src/services/context-sources'
import type { AITaskEnvelope, ContextBundle } from '../src/shared/domain'

const setup = (maxContextTokens = 16_000) => {
  const db = createTestDb(); const project = new ProjectService(db).create({ title: '上下文清单', projectType: 'novel' })
  const documents = new DocumentService(db); const chapter = documents.listOrderedChapters(project.id)[0]
  documents.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '正文：雨夜里林舟推开了旧书店的门。' })
  const memories = new MemoryService(db)
  const memory = memories.create({ projectId: project.id, type: 'fact', content: '设定：旧书店老板其实是林舟的舅舅。', status: 'suggested', sourceType: 'author', sourceId: 'note' })
  memories.confirm(project.id, memory.id, 'user')
  const providers = new ProviderService(db, testCodec)
  providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'fixture', baseUrl: 'http://fixture/v1', apiKey: 'k' })
  providers.saveModel({ id: 'm', providerId: 'p', modelId: 'm', displayName: 'fixture', enabled: true, isDefault: true,
    capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true, maxContextTokens } })
  const thread = new ChatService(db).createThread(project.id)
  const captured: ProviderMessage[][] = []
  const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function * (input: { model: string; messages: ProviderMessage[] }) { captured.push(input.messages); yield '好' } }))
  const task: AITaskEnvelope = { mode: 'discussion', writePermission: 'none', userIntent: '这一章节奏如何？', projectId: project.id, documentId: chapter.id }
  return { db, project, chapter, memory, thread, runtime, captured, task }
}

const runOnce = async (runtime: AICreativeRuntime, task: AITaskEnvelope, threadId: string, id: string): Promise<ContextBundle> => {
  let sent: ContextBundle | undefined
  for await (const event of runtime.run(`r-${id}`, task, threadId, `u-${id}`, `a-${id}`)) sent ??= event.context
  return sent!
}

describe('S6 上下文来源清单与逐条排除（R4）', () => {
  it('④ 面板预览列出的条目 = 实际发送 messages 中的条目', async () => {
    const { runtime, captured, task, thread, memory, chapter } = setup()
    const preview = runtime.previewContext(task, thread.id)
    const sent = await runOnce(runtime, task, thread.id, '1')
    expect(preview.items.map((item) => [item.kind, item.id])).toEqual(sent.items.map((item) => [item.kind, item.id]))
    expect(preview.items.map((item) => item.content)).toEqual(sent.items.map((item) => item.content))
    const ids = preview.items.map((item) => item.id)
    expect(ids).toContain(memory.id); expect(ids).toContain(chapter.id)
    // 发送的上下文 system 消息恰好由清单条目拼成（无清单外条目、无遗漏）
    const contextMessage = captured[0][1].content
    const body = contextMessage.slice(contextMessage.indexOf('\n') + 1)
    expect(body).toBe(sent.items.map((item) => `[${item.kind}] ${item.title}\n${item.content}`).join('\n\n'))
  })

  it('⑤ 排除某条后，请求中不含该文本，且清单标注为已排除', async () => {
    const { runtime, captured, task, thread, memory } = setup()
    const excludedTask = { ...task, excludedIds: [memory.id] }
    const preview = runtime.previewContext(excludedTask, thread.id)
    expect(preview.items.some((item) => item.id === memory.id)).toBe(false)
    expect(preview.metadata.omitted).toContainEqual(expect.objectContaining({ id: memory.id, reason: 'user_excluded' }))
    const sent = await runOnce(runtime, excludedTask, thread.id, '2')
    expect(JSON.stringify(captured[0])).not.toContain('旧书店老板其实是林舟的舅舅')
    expect(JSON.stringify(captured[0])).toContain('雨夜里林舟推开了旧书店的门')
    expect(sent.items.map((item) => item.id)).toEqual(preview.items.map((item) => item.id))
  })

  it('排除正文 id 时同 id 的所有条目（正文/检索片段）都不发送', () => {
    const { db, task, chapter } = setup()
    const bundle = new ContextEngine(db).build({ ...task, userIntent: '雨夜 旧书店', excludedIds: [chapter.id] })
    expect(bundle.items.some((item) => item.id === chapter.id)).toBe(false)
    expect(JSON.stringify(bundle.items)).not.toContain('雨夜里林舟推开了旧书店的门')
  })

  it('读者模式同样支持排除', () => {
    const { db, project, chapter } = setup()
    const bundle = new ContextEngine(db).build({ mode: 'reader_review', writePermission: 'none', userIntent: '读者怎么看', projectId: project.id, throughChapterId: chapter.id, excludedIds: [chapter.id] })
    expect(JSON.stringify(bundle.items)).not.toContain('雨夜里林舟')
  })

  it('S7 接口：预算不足时被省略的条目记录为 budget，截断条目带 truncated', () => {
    const { db, task } = setup()
    const bundle = new ContextEngine(db).build(task, 5)
    expect(bundle.items.length).toBe(1)
    expect(bundle.items[0].truncated).toBe(true)
    expect((bundle.metadata.omitted ?? []).every((item) => item.reason === 'budget')).toBe(true)
    expect(bundle.metadata.omitted?.length).toBeGreaterThan(0)
  })

  it('未配置模型时也能预览（不解密密钥、不发请求）', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '无模型', projectType: 'novel' })
    const thread = new ChatService(db).createThread(project.id)
    const runtime = new AICreativeRuntime(db, new ProviderService(db, testCodec), () => { throw new Error('should not create adapter') })
    expect(runtime.previewContext({ mode: 'discussion', writePermission: 'none', userIntent: '', projectId: project.id }, thread.id).policy).toBe('creative')
  })

  it('renderer 辅助：清单行包含已发送与已省略，切换排除 id', () => {
    const rows = toContextSourceRows({ projectId: 'p', policy: 'creative', items: [{ id: 'a', kind: 'memory', title: 'A', content: 'x  y', projectId: 'p', reason: 'r', truncated: true }],
      metadata: { estimatedTokens: 1, sourceIds: ['a'], excludedKinds: [], omitted: [{ id: 'b', kind: 'note', title: 'B', reason: 'user_excluded' }] } })
    expect(rows).toEqual([expect.objectContaining({ id: 'a', included: true, truncated: true, preview: 'x y' }), expect.objectContaining({ id: 'b', included: false, omittedReason: 'user_excluded' })])
    expect(toggleExcludedId(['a'], 'b')).toEqual(['a', 'b']); expect(toggleExcludedId(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('IPC schema：excludedIds 校验', () => {
    const base = { requestId: 'r', threadId: 't', userMessageId: 'u', assistantMessageId: 'a',
      task: { mode: 'discussion', writePermission: 'none', userIntent: 'hi', projectId: 'p' } }
    expect(aiStartSchema.safeParse({ ...base, task: { ...base.task, excludedIds: ['selection:doc', 'm1'] } }).success).toBe(true)
    expect(aiStartSchema.safeParse({ ...base, task: { ...base.task, excludedIds: [''] } }).success).toBe(false)
    expect(aiStartSchema.safeParse({ ...base, task: { ...base.task, excludedIds: 'm1' } }).success).toBe(false)
    expect(aiStartSchema.safeParse({ ...base, task: { ...base.task, excludedIds: Array.from({ length: 501 }, (_, i) => `x${i}`) } }).success).toBe(false)
    expect(aiPreviewContextSchema.safeParse({ threadId: 't', task: { ...base.task, userIntent: '' } }).success).toBe(true)
    expect(aiPreviewContextSchema.safeParse({ threadId: '', task: base.task }).success).toBe(false)
  })

  it('大纲进清单且默认不发送；勾选 includedIds 后发送且无正文进 snapshot', async () => {
    const { db, project, runtime, captured, task, thread } = setup()
    const docs = new DocumentService(db)
    const volume = docs.listTree(project.id).find((node) => node.type === 'volume')!
    docs.saveOutline({ projectId: project.id, nodeId: volume.id, summary: '卷一主线：旧书店的秘密', beats: ['开场雨夜'], hook: '舅舅现身' })
    const outlineId = `outline:${volume.id}`
    const preview = runtime.previewContext(task, thread.id)
    expect(preview.metadata.omitted).toContainEqual(expect.objectContaining({ id: outlineId, kind: 'outline', reason: 'default_excluded' }))
    expect(preview.items.some((item) => item.id === outlineId)).toBe(false)
    expect(JSON.stringify(preview.items)).not.toContain('旧书店的秘密')
    const withOutline = { ...task, includedIds: [outlineId] }
    const sent = await runOnce(runtime, withOutline, thread.id, 'outline')
    expect(sent.items.some((item) => item.id === outlineId)).toBe(true)
    expect(JSON.stringify(captured[0])).toContain('旧书店的秘密')
    const row = db.raw.prepare('SELECT context_snapshot_json AS j FROM chat_messages WHERE role = ? ORDER BY created_at DESC LIMIT 1').get('assistant') as { j: string }
    const snap = JSON.parse(row.j) as { sources: Array<{ id: string; kind: string }>; omitted: Array<{ id: string; kind: string; reason: string }> }
    expect(snap.sources.some((item) => item.id === outlineId && item.kind === 'outline')).toBe(true)
    expect(JSON.stringify(snap)).not.toContain('旧书店的秘密')
    expect(JSON.stringify(snap)).not.toContain('雨夜里林舟')
  })

  it('snapshot 只含 id/类型/排除原因，不含正文', async () => {
    const { db, runtime, task, thread, memory } = setup()
    await runOnce(runtime, { ...task, excludedIds: [memory.id] }, thread.id, 'snap')
    const row = db.raw.prepare('SELECT context_snapshot_json AS j FROM chat_messages WHERE role = ? ORDER BY created_at DESC LIMIT 1').get('user') as { j: string }
    const snap = JSON.parse(row.j) as { sources: Array<{ id: string; kind: string; content?: string }>; omitted: Array<{ id: string; kind: string; reason: string }> }
    expect(snap.omitted).toContainEqual(expect.objectContaining({ id: memory.id, reason: 'user_excluded' }))
    expect(snap.sources.every((item) => item.id && item.kind && !('content' in item))).toBe(true)
    expect(JSON.stringify(snap)).not.toContain('旧书店老板其实是林舟的舅舅')
    expect(JSON.stringify(snap)).not.toContain('雨夜里林舟')
  })

  it('isRowChecked：大纲默认未勾选，勾选后靠 includedIds', () => {
    const row = { id: 'outline:v', kind: 'outline' as const, title: '大纲', reason: '', preview: '', included: false, truncated: false, omittedReason: 'default_excluded' as const }
    expect(isRowChecked(row, [], [])).toBe(false)
    expect(isRowChecked(row, [], ['outline:v'])).toBe(true)
  })

})
