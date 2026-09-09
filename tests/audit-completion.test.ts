import { afterEach, describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb, testCodec } from './helpers'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ChapterDigestService } from '../src/main/ai/chapter-digest-service'
import { ChapterDigestRunner } from '../src/main/ai/digest-runner'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { ProofreadingRunner } from '../src/main/ai/proofreading-runner'
import { ProviderService, OpenAICompatibleAdapter, type ProviderMessage } from '../src/main/ai/provider'
import { BackupService } from '../src/main/services/backup-service'
import { ChatService } from '../src/main/services/chat-service'
import { ProjectContentService } from '../src/main/services/project-content-service'
import { buildTiptapTextSpans, findTextRange, plainTextRangeToPm } from '../src/renderer/src/services/prosemirror-range'

const editorJson = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }] })
const digestJson = (summary = '摘要', candidate = '事实'): string => JSON.stringify({ summary, events: [], characterChanges: [], reveals: [], openQuestions: [], memoryCandidates: candidate ? [{ type: 'fact', content: candidate }] : [], possibleContradictions: [] })

async function collect(adapter: OpenAICompatibleAdapter): Promise<string> {
  let result = ''
  for await (const chunk of adapter.chat({ model: 'm', messages: [] })) result += chunk
  return result
}

describe('provider completion state', () => {
  it('rejects partial error events and unexpected EOF instead of reporting complete', async () => {
    const encoder = new TextEncoder()
    const make = (chunks: string[]) => new OpenAICompatibleAdapter('http://fixture/v1', 'k', async () => new Response(new ReadableStream({
      start(controller) { chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk))); controller.close() }
    }), { status: 200 }))
    const providerError = make(['data: {"choices":[{"delta":{"content":"部分"}}]}\n\n', 'data: {"error":{"message":"fixture failed"}}\n\n'])
    await expect(collect(providerError)).rejects.toMatchObject({ code: 'PROVIDER_STREAM_ERROR' })
    const eof = make(['data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'])
    await expect(collect(eof)).rejects.toMatchObject({ code: 'PROVIDER_UNEXPECTED_EOF' })
  })

  it('rejects malformed 200 connection responses and enforces a deadline', async () => {
    const html = new OpenAICompatibleAdapter('http://fixture/v1', 'k', async () => new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    expect((await html.testConnection('m')).ok).toBe(false)
    const never = new OpenAICompatibleAdapter('http://fixture/v1', 'k', ((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })) as typeof fetch)
    await expect(never.complete({ model: 'm', messages: [], timeoutMs: 5 })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' })
  })
})

describe('nested ProseMirror mapping', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' }, blockquote: { content: 'block+', group: 'block' },
      bulletList: { content: 'listItem+', group: 'block' }, orderedList: { content: 'listItem+', group: 'block' },
      listItem: { content: 'paragraph block*' }, hardBreak: { inline: true, group: 'inline', atom: true }, text: { group: 'inline' }
    },
    marks: { bold: {}, italic: {} }
  })
  const doc = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: '粗' }, { type: 'text', marks: [{ type: 'italic' }], text: '体😀' }] }, { type: 'paragraph' }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '甲' }, { type: 'hardBreak' }, { type: 'text', text: '目标' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '嵌套' }] }] }] }] }] }
  ] })

  it('maps marked text, emoji, hard breaks and nested list text to real PM positions', () => {
    const serialized = buildTiptapTextSpans(doc)
    expect(serialized.text).toContain('粗体😀')
    expect(serialized.text).toContain('甲\n目标')
    const marked = findTextRange(doc, '粗体😀')!
    expect(doc.textBetween(marked.from, marked.to, '\n\n')).toBe('粗体😀')
    const nested = findTextRange(doc, '目标')!
    expect(doc.textBetween(nested.from, nested.to, '\n\n')).toBe('目标')
    const breakOffset = serialized.text.indexOf('甲\n目标') + 1
    const hardBreak = plainTextRangeToPm(doc, breakOffset, breakOffset + 1)!
    expect(doc.nodeAt(hardBreak.from)?.type.name).toBe('hardBreak')
  })

  it('refuses ranges crossing virtual block separators', () => {
    const text = buildTiptapTextSpans(doc).text
    const from = text.indexOf('体😀')
    const to = text.indexOf('目标') + 2
    expect(plainTextRangeToPm(doc, from, to)).toBeUndefined()
  })
})

describe('source revision identity', () => {
  it('does not store an old digest as fresh after the chapter changes in flight', async () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '摘要竞态', projectType: 'novel' })
    const documents = new DocumentService(db)
    const chapter = documents.listOrderedChapters(project.id)[0]
    const first = documents.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson('初稿'), plainText: '初稿' })
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'fixture', baseUrl: 'http://fixture/v1', apiKey: 'k' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'm', displayName: 'fixture', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true, maxContextTokens: 8_000 } })
    let release!: (value: string) => void
    const completion = new Promise<string>((resolve) => { release = resolve })
    const runner = new ChapterDigestRunner(db, providers, () => ({ complete: async () => completion }))
    const pending = runner.run(project.id, chapter.id)
    documents.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson('二稿'), plainText: '二稿', expectedRevision: first.revision })
    release(digestJson('旧摘要', '旧候选'))
    await expect(pending).rejects.toThrow('DIGEST_SOURCE_STALE')
    expect(new ChapterDigestService(db).list(project.id, chapter.id)).toHaveLength(0)
  })

  it('does not let an older same-revision digest request overwrite a newer response', async () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '摘要乱序', projectType: 'novel' })
    const chapter = new DocumentService(db).listOrderedChapters(project.id)[0]
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'fixture', baseUrl: 'http://fixture/v1', apiKey: 'k' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'm', displayName: 'fixture', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true, maxContextTokens: 8_000 } })
    const releases: Array<(value: string) => void> = []
    const runner = new ChapterDigestRunner(db, providers, () => ({ complete: () => new Promise<string>((resolve) => releases.push(resolve)) }))
    const older = runner.run(project.id, chapter.id)
    const newer = runner.run(project.id, chapter.id)
    releases[1](digestJson('新请求', ''))
    await expect(newer).resolves.toMatchObject({ repaired: false })
    releases[0](digestJson('旧请求', ''))
    await expect(older).rejects.toThrow('DIGEST_REQUEST_SUPERSEDED')
    expect(new ChapterDigestService(db).list(project.id, chapter.id).map((item) => item.summary)).toEqual(['新请求'])
  })

  it('keeps digest status reads pure and rejects stale chapter candidates inside confirm', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '记忆来源', projectType: 'novel' })
    const documents = new DocumentService(db); const chapter = documents.listOrderedChapters(project.id)[0]
    const saved = documents.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson('正文一'), plainText: '正文一' })
    const digests = new ChapterDigestService(db)
    digests.storeFromModel(project.id, chapter.id, digestJson('摘要一', '事实一'), saved.revision)
    const memories = new MemoryService(db); const proposal = memories.list(project.id, ['suggested'])[0]
    expect(proposal).toMatchObject({ sourceRevision: saved.revision, sourceDigestId: expect.any(String) })
    documents.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson('正文二'), plainText: '正文二', expectedRevision: saved.revision })
    expect(digests.status(project.id, chapter.id).state).toBe('stale')
    expect(memories.list(project.id).find((item) => item.id === proposal.id)?.status).toBe('suggested')
    expect(() => memories.confirm(project.id, proposal.id, 'user')).toThrow('MEMORY_SOURCE_STALE')
  })
})

describe('final request budgeting and deterministic long-document chunks', () => {
  it('keeps the complete provider message list below the configured input budget', async () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '预算', projectType: 'novel' })
    const documents = new DocumentService(db); const chapter = documents.listOrderedChapters(project.id)[0]
    documents.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson('长正文'.repeat(10_000)), plainText: '长正文'.repeat(10_000) })
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'fixture', baseUrl: 'http://fixture/v1', apiKey: 'k' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'm', displayName: 'fixture', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true, maxContextTokens: 2_000 } })
    const chat = new ChatService(db); const thread = chat.createThread(project.id)
    let captured: Array<{ content: string }> = []
    const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function * (input: { model: string; messages: ProviderMessage[]; signal?: AbortSignal; timeoutMs?: number }) { captured = input.messages; yield '完成' } }))
    for await (const _ of runtime.run('r', { mode: 'generation', writePermission: 'proposal', userIntent: '继续'.repeat(1_000), projectId: project.id, documentId: chapter.id }, thread.id, 'u', 'a')) void _
    const estimated = captured.reduce((sum, message) => sum + Math.ceil(message.content.length / 2.2) + 4, 0)
    expect(estimated).toBeLessThanOrEqual(1_600)
  })

  it('chunks long digest and proofreading requests instead of sending the whole chapter', async () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '分段', projectType: 'novel' })
    const documents = new DocumentService(db); const chapter = documents.listOrderedChapters(project.id)[0]
    documents.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson('甲。'.repeat(2_000)), plainText: '甲。'.repeat(2_000) })
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'fixture', baseUrl: 'http://fixture/v1', apiKey: 'k' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'm', displayName: 'fixture', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true, maxContextTokens: 600 } })
    let digestCalls = 0
    const digest = new ChapterDigestRunner(db, providers, () => ({ complete: async () => { digestCalls += 1; return digestJson(`分段 ${digestCalls}`, '') } }))
    await digest.run(project.id, chapter.id)
    expect(digestCalls).toBeGreaterThan(1)
    expect(new ChapterDigestService(db).status(project.id, chapter.id).state).toBe('fresh')
    let proofreadCalls = 0
    const proofreading = new ProofreadingRunner(db, providers, () => ({ complete: async () => { proofreadCalls += 1; return JSON.stringify({ issues: [] }) } }))
    await proofreading.run(project.id, chapter.id)
    expect(proofreadCalls).toBeGreaterThan(1)
  })
})

describe('stable persistence boundaries', () => {
  it('loads 60 same-millisecond chat messages exactly once with a compound cursor', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '分页', projectType: 'novel' })
    const chat = new ChatService(db); const thread = chat.createThread(project.id)
    for (let index = 0; index < 30; index += 1) {
      const suffix = index.toString().padStart(2, '0')
      chat.startTurn({ projectId: project.id, threadId: thread.id, userMessageId: `u-${suffix}`, assistantMessageId: `a-${suffix}`, content: suffix, mode: 'discussion' })
      chat.updateAssistant(project.id, thread.id, `a-${suffix}`, suffix, 'complete')
    }
    db.raw.prepare('UPDATE chat_messages SET created_at = 1000 WHERE project_id = ? AND thread_id = ?').run(project.id, thread.id)
    const collected: string[] = []
    let cursor: { createdAt: number; id: string } | undefined
    do {
      const page = chat.listMessages(project.id, thread.id, cursor, 20)
      collected.push(...page.map((message) => message.id))
      cursor = page.length === 20 ? { createdAt: page[0].createdAt, id: page[0].id } : undefined
      if (page.length < 20) break
    } while (cursor)
    expect(collected).toHaveLength(60)
    expect(new Set(collected).size).toBe(60)
  })

  it('preserves omitted character extension fields during a UI-style partial save', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '人物字段', projectType: 'novel' })
    const content = new ProjectContentService(db)
    const created = content.saveCharacter({ projectId: project.id, name: '旧名', aliases: ['别名'], notes: '笔记', fields: { age: '18', faction: '北方' } })
    const saved = content.saveCharacter({ id: created.id, projectId: project.id, name: '新名' })
    expect(saved).toMatchObject({ name: '新名', aliases: ['别名'], notes: '笔记', fields: { age: '18', faction: '北方' } })
    expect(content.saveCharacter({ id: created.id, projectId: project.id, name: '新名', fields: {} }).fields).toEqual({})
  })
})

describe('ordered migrations and backup graph restore', () => {
  const directories: string[] = []
  afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

  it('refuses a database created by a newer application schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inkstone-future-')); directories.push(directory)
    const path = join(directory, 'future.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)')
    raw.prepare("INSERT INTO app_settings VALUES ('schema_version', ?, 0)").run(JSON.stringify(CURRENT_SCHEMA_VERSION + 1))
    raw.close()
    expect(() => new AppDatabase(path)).toThrow('DATABASE_SCHEMA_TOO_NEW')
  })

  it('round-trips multi-generation replacement graphs in arbitrary array order and rejects cycles without residue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inkstone-backup-')); directories.push(directory)
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '关系图', projectType: 'novel' })
    const memories = new MemoryService(db)
    const first = memories.create({ projectId: project.id, type: 'fact', content: 'A', status: 'suggested', sourceType: 'author', sourceId: 'author' })
    memories.confirm(project.id, first.id, 'user')
    const second = memories.proposeReplacement(project.id, first.id, 'B'); memories.confirm(project.id, second.id, 'user')
    const third = memories.proposeReplacement(project.id, second.id, 'C'); memories.confirm(project.id, third.id, 'user')
    const backup = new BackupService(db); const original = join(directory, 'source.aiwproj')
    await backup.exportProject(project.id, original)
    const payload = JSON.parse(await readFile(original, 'utf8')) as { memories: Array<Record<string, unknown>> }
    for (let index = 0; index < 21; index += 1) {
      const shuffled = { ...payload, memories: [...payload.memories].sort((a, b) => String(a.id).localeCompare(String(b.id)) * (index % 2 ? -1 : 1)) }
      if (index % 3 === 0) shuffled.memories.push(...shuffled.memories.splice(0, 1))
      const path = join(directory, `shuffle-${index}.aiwproj`)
      await writeFile(path, JSON.stringify(shuffled))
      const imported = await backup.importProject(path)
      const restored = memories.list(imported.id)
      expect(restored).toHaveLength(3)
      const restoredC = restored.find((item) => item.content === 'C')!
      const restoredB = restored.find((item) => item.id === restoredC.supersedes)!
      expect(restoredB.content).toBe('B')
      expect(restored.find((item) => item.id === restoredB.supersedes)?.content).toBe('A')
    }
    const before = new ProjectService(db).list(true).length
    const cyclic = structuredClone(payload)
    cyclic.memories.find((item) => item.content === 'A')!.supersedes = cyclic.memories.find((item) => item.content === 'C')!.id
    const badPath = join(directory, 'cycle.aiwproj'); await writeFile(badPath, JSON.stringify(cyclic))
    await expect(backup.importProject(badPath)).rejects.toThrow('BACKUP_INVALID_MEMORY_CYCLE')
    expect(new ProjectService(db).list(true)).toHaveLength(before)
  })
})
