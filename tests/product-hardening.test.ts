import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { ChapterDigestService } from '../src/main/ai/chapter-digest-service'
import { ContextEngine } from '../src/main/ai/context-engine'
import { MemoryIntentRunner } from '../src/main/ai/memory-intent'
import { ProofreadingRunner } from '../src/main/ai/proofreading-runner'
import { ProviderService } from '../src/main/ai/provider'
import { StyleEngine } from '../src/main/ai/style-engine'
import { DocumentService } from '../src/main/services/document-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ProjectService } from '../src/main/services/project-service'
import { StyleSampleService } from '../src/main/services/style-sample-service'
import { canInsertCandidate, mapChatHistory, resolveDisplayedModelMode, resolveModelDisplayName, retryInputForMessage } from '../src/renderer/src/services/assistant-history'
import { findTextRanges } from '../src/renderer/src/services/prosemirror-range'
import { createTestDb, testCodec } from './helpers'

const editorJson = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

describe('product hardening invariants', () => {
  it('keeps the old confirmed memory active until a replacement is confirmed, then preserves traceable history', async () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '记忆生命周期', projectType: 'novel' })
    const memories = new MemoryService(db)
    const old = memories.create({ projectId: project.id, type: 'fact', content: '钥匙藏在钟楼', status: 'suggested', sourceType: 'author', sourceId: 'author' })
    memories.confirm(project.id, old.id, 'user')
    const replacement = memories.proposeReplacement(project.id, old.id, '钥匙藏在旧车站')
    const competingReplacement = memories.proposeReplacement(project.id, old.id, '钥匙藏在河岸仓库')

    expect(memories.list(project.id).find((item) => item.id === old.id)?.status).toBe('confirmed')
    const before = new ContextEngine(db).build({ mode: 'discussion', writePermission: 'none', userIntent: '钥匙藏在哪里', projectId: project.id })
    expect(JSON.stringify(before)).toContain('钥匙藏在钟楼')
    expect(JSON.stringify(before)).not.toContain('钥匙藏在旧车站')

    memories.confirm(project.id, replacement.id, 'user')
    const after = memories.list(project.id)
    expect(after.find((item) => item.id === old.id)?.status).toBe('superseded')
    expect(after.find((item) => item.id === replacement.id)).toMatchObject({ status: 'confirmed', supersedes: old.id })
    expect(after.find((item) => item.id === competingReplacement.id)?.status).toBe('rejected')
    const active = new ContextEngine(db).build({ mode: 'discussion', writePermission: 'none', userIntent: '钥匙藏在哪里', projectId: project.id })
    expect(JSON.stringify(active)).toContain('钥匙藏在旧车站')
    expect(JSON.stringify(active)).not.toContain('钥匙藏在钟楼')

    memories.retire(project.id, replacement.id)
    expect(JSON.stringify(new ContextEngine(db).build({ mode: 'discussion', writePermission: 'none', userIntent: '钥匙藏在哪里', projectId: project.id }))).not.toContain('钥匙藏在旧车站')

    const second = memories.create({ projectId: project.id, type: 'fact', content: '门在北侧', status: 'suggested', sourceType: 'author', sourceId: 'author' })
    memories.confirm(project.id, second.id, 'user')
    const proposals = await new MemoryIntentRunner(db, new ProviderService(db, testCodec)).extractAndCreate(project.id, 'chat', '门在北侧不要了，改成门在南侧。')
    expect(proposals[0]).toMatchObject({ content: '门在南侧', supersedes: second.id, status: 'suggested' })
  })

  it('withdraws only unconfirmed candidates when their chapter digest becomes stale', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '陈旧摘要', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]; const digests = new ChapterDigestService(db)
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson('红伞在门边。'), plainText: '红伞在门边。' })
    digests.storeFromModel(project.id, chapter.id, JSON.stringify({ summary: '红伞在门边。', memoryCandidates: [{ type: 'fact', content: '红伞在门边' }] }))
    const candidate = new MemoryService(db).list(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson('红伞已被拿走。'), plainText: '红伞已被拿走。' })
    expect(new MemoryService(db).list(project.id).find((item) => item.id === candidate.id)?.status).toBe('rejected')
    expect(JSON.stringify(new ContextEngine(db).build({ mode: 'discussion', writePermission: 'none', userIntent: '红伞', projectId: project.id, documentId: chapter.id }))).not.toContain('红伞在门边')

    digests.storeFromModel(project.id, chapter.id, JSON.stringify({ summary: '红伞已被拿走。', memoryCandidates: [{ type: 'fact', content: '红伞被周青拿走' }] }))
    const confirmed = new MemoryService(db).list(project.id, ['suggested'])[0]
    new MemoryService(db).confirm(project.id, confirmed.id, 'user')
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson('红伞被拿走后，门边空了。'), plainText: '红伞被拿走后，门边空了。' })
    expect(new MemoryService(db).list(project.id).find((item) => item.id === confirmed.id)?.status).toBe('confirmed')
  })

  it('associates retry with the failed turn and disables insertion for persisted generation history', () => {
    const history = mapChatHistory([
      { id: 'u1', threadId: 't', projectId: 'p', role: 'user', content: '问题一', taskMode: 'discussion', status: 'complete', createdAt: 1 },
      { id: 'a1', threadId: 't', projectId: 'p', role: 'assistant', content: '', taskMode: 'discussion', status: 'error', createdAt: 2 },
      { id: 'u2', threadId: 't', projectId: 'p', role: 'user', content: '问题二', taskMode: 'generation', status: 'complete', createdAt: 3 },
      { id: 'a2', threadId: 't', projectId: 'p', role: 'assistant', content: '候选正文', taskMode: 'generation', status: 'complete', createdAt: 4 }
    ])
    expect(retryInputForMessage(history, 'a1')).toBe('问题一')
    const cancelled = mapChatHistory([{ id: 'a3', threadId: 't', projectId: 'p', role: 'assistant', content: '部分响应', taskMode: 'discussion', status: 'cancelled', createdAt: 5 }])[0]
    expect(cancelled.content).toBe('部分响应\n\n请求已取消。')
    expect(canInsertCandidate(history[3])).toBe(false)
    expect(canInsertCandidate({ ...history[3], historical: false })).toBe(true)
    expect(canInsertCandidate({ ...history[3], historical: false, inserted: true })).toBe(false)
  })

  it('shows the routed model and truthfully falls back when that model is disabled', () => {
    const base = { providerId: 'p', modelId: 'id', capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true }, enabled: true }
    const models = [{ ...base, id: 'default', displayName: '默认模型', isDefault: true }, { ...base, id: 'writer', displayName: '续写模型', isDefault: false }]
    const routes = { discussion: 'default', brainstorm: 'default', generation: 'writer', editing: 'default', organization: 'default', chapter_digest: 'default', proofreading: 'default' } as const
    expect(resolveModelDisplayName('generation', models, routes)).toBe('续写模型')
    expect(resolveModelDisplayName('generation', models.map((model) => model.id === 'writer' ? { ...model, enabled: false } : model), routes)).toBe('默认模型')
    expect(resolveDisplayedModelMode('discussion', 'generation')).toBe('generation')
    expect(resolveDisplayedModelMode('brainstorm')).toBe('brainstorm')
  })

  it('grounds duplicate proofreading issues to the requested occurrence and rejects ambiguous results', async () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '重复校对', projectType: 'novel' }); const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]; const text = '她慢慢的走进门。后来，她慢慢的走进门。'
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: editorJson(text), plainText: text })
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: '本地测试', baseUrl: 'http://local', apiKey: 'k' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'm', displayName: '测试模型', enabled: true, isDefault: true, capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    const result = JSON.stringify({ issues: [
      { category: 'grammar', originalText: '慢慢的走进', suggestion: '慢慢地走进', reason: '状语', occurrence: 2, contextBefore: '后来，她', contextAfter: '门。' },
      { category: 'grammar', originalText: '慢慢的走进', suggestion: '慢慢地走进', reason: '未定位' }
    ] })
    const issues = await new ProofreadingRunner(db, providers, () => ({ complete: async () => result })).run(project.id, chapter.id)
    expect(issues).toHaveLength(1); expect(issues[0].occurrence).toBe(2)

    const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } } })
    const ranges = findTextRanges(schema.nodeFromJSON(editorJson(text)), '慢慢的走进')
    expect(ranges).toHaveLength(2); expect(ranges[1].from).toBeGreaterThan(ranges[0].from)
  })

  it('learns rewritten author prose after AI text is removed, deduplicates samples and keeps projects isolated', () => {
    const db = createTestDb(); const projects = new ProjectService(db); const a = projects.create({ title: '风格甲', projectType: 'novel' }); const b = projects.create({ title: '风格乙', projectType: 'novel' })
    const docs = new DocumentService(db); const chapterA = docs.listOrderedChapters(a.id)[0]; const chapterB = docs.listOrderedChapters(b.id)[0]
    const human = '雨落在旧站台上，声音细而有节制。'.repeat(10); const ai = '模型生成的原始段落没有经过作者修改，不能直接成为长期风格。'.repeat(3)
    docs.saveContent({ projectId: a.id, documentId: chapterA.id, editorJson: editorJson(human), plainText: human })
    docs.saveContent({ projectId: a.id, documentId: chapterA.id, editorJson: editorJson(`${human}${ai}`), plainText: `${human}${ai}`, styleSample: { origin: 'ai', text: ai } })
    docs.saveContent({ projectId: a.id, documentId: chapterA.id, editorJson: editorJson(`${human}作者改写了一次。`), plainText: `${human}作者改写了一次。` })
    expect(new StyleSampleService(db).list(a.id).some((sample) => sample.origin === 'ai_edited_by_human')).toBe(false)
    docs.saveContent({ projectId: a.id, documentId: chapterA.id, editorJson: editorJson(`${human}作者重新安排了整段节奏与措辞。`), plainText: `${human}作者重新安排了整段节奏与措辞。` })
    expect(new StyleSampleService(db).list(a.id).some((sample) => sample.origin === 'ai_edited_by_human')).toBe(true)

    const samples = new StyleSampleService(db)
    for (let index = 0; index < 6; index += 1) samples.record({ projectId: a.id, documentId: chapterA.id, origin: 'human', text: `甲作品风格样本${index}：${'安静克制的句子。'.repeat(4)}`, sourceRevision: 10 + index })
    samples.record({ projectId: b.id, documentId: chapterB.id, origin: 'human', text: `乙作品独有：${'明亮跳跃的句子。'.repeat(4)}`, sourceRevision: 1 })
    const retrievedA = new StyleEngine(db).retrieve(a.id)
    expect(retrievedA.filter((sample) => sample.documentId === chapterA.id).length).toBeLessThanOrEqual(4)
    expect(JSON.stringify(retrievedA)).not.toContain('乙作品独有')
    expect(JSON.stringify(new StyleEngine(db).retrieve(b.id))).toContain('乙作品独有')
  })
})
