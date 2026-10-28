import { describe, expect, it } from 'vitest'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { ProviderService } from '../src/main/ai/provider'
import { ChatService } from '../src/main/services/chat-service'
import { DocumentService } from '../src/main/services/document-service'
import { PatchService } from '../src/main/services/patch-service'
import { ProjectService } from '../src/main/services/project-service'
import { DEFAULT_CANDIDATE_COUNT, MAX_CANDIDATE_COUNT, normalizeCandidateCount } from '../src/shared/candidate-count'
import { aiStartSchema } from '../src/main/ipc/schemas'
import { activeCandidateText, canProposeGenerationPatch, canInsertCandidate } from '../src/renderer/src/services/assistant-history'
import { createTestDb, testCodec } from './helpers'

describe('S8 generation multi-candidates (§4 ①②③)', () => {
  it('normalizeCandidateCount defaults to 1 and clamps to 1–3', () => {
    expect(DEFAULT_CANDIDATE_COUNT).toBe(1)
    expect(MAX_CANDIDATE_COUNT).toBe(3)
    expect(normalizeCandidateCount(undefined)).toBe(1)
    expect(normalizeCandidateCount(0)).toBe(1)
    expect(normalizeCandidateCount(-2)).toBe(1)
    expect(normalizeCandidateCount(1.9)).toBe(1)
    expect(normalizeCandidateCount(2)).toBe(2)
    expect(normalizeCandidateCount(3)).toBe(3)
    expect(normalizeCandidateCount(99)).toBe(3)
    expect(normalizeCandidateCount('x')).toBe(1)
  })

  it('aiTaskSchema accepts candidateCount 1–3 and rejects out of range', () => {
    const base = {
      requestId: 'r', threadId: 't', userMessageId: 'u', assistantMessageId: 'a',
      task: { mode: 'generation', writePermission: 'proposal', userIntent: '续写', projectId: 'p', candidateCount: 2 }
    }
    expect(aiStartSchema.safeParse(base).success).toBe(true)
    expect(aiStartSchema.safeParse({ ...base, task: { ...base.task, candidateCount: 1 } }).success).toBe(true)
    expect(aiStartSchema.safeParse({ ...base, task: { ...base.task, candidateCount: 3 } }).success).toBe(true)
    expect(aiStartSchema.safeParse({ ...base, task: { ...base.task, candidateCount: 0 } }).success).toBe(false)
    expect(aiStartSchema.safeParse({ ...base, task: { ...base.task, candidateCount: 4 } }).success).toBe(false)
  })

  it('§4 ① idle: constructing runtime / previewContext does not hit the provider (0 requests)', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '空闲', projectType: 'novel' })
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: '本地', baseUrl: 'http://localhost:11434/v1', apiKey: '' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'local', displayName: '本地', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    let hits = 0
    const runtime = new AICreativeRuntime(db, providers, () => {
      hits += 1
      return { chat: async function* () { yield '不应调用' } }
    })
    const thread = new ChatService(db).createThread(project.id, '空闲')
    expect(hits).toBe(0)
    runtime.previewContext({ mode: 'generation', writePermission: 'proposal', userIntent: '续写', projectId: project.id, candidateCount: 3 }, thread.id)
    expect(hits).toBe(0)
  })

  it('runtime generation with candidateCount=3 yields three texts and only streams the first', async () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '多候选', projectType: 'novel' })
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: '本地', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'local', displayName: '本地', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    const outputs = ['候选甲全文', '候选乙全文', '候选丙全文']
    let chatCalls = 0
    const runtime = new AICreativeRuntime(db, providers, () => ({
      chat: async function* () {
        const text = outputs[chatCalls] ?? '额外'
        chatCalls += 1
        yield text
      }
    }))
    const thread = new ChatService(db).createThread(project.id, '续写')
    const chunks: string[] = []
    let candidates: string[] | undefined
    for await (const event of runtime.run('r-multi', {
      mode: 'generation', writePermission: 'proposal', userIntent: '继续写', projectId: project.id, candidateCount: 3
    }, thread.id, 'u', 'a')) {
      if (event.candidates) candidates = event.candidates
      if (event.chunk) chunks.push(event.chunk)
    }
    expect(chatCalls).toBe(3)
    expect(chunks.join('')).toBe('候选甲全文')
    expect(candidates).toEqual(['候选甲全文', '候选乙全文', '候选丙全文'])
    // 聊天库只持久化首个候选正文；其余候选仅经事件返回，不写 text_patches
    const messages = new ChatService(db).listMessages(project.id, thread.id)
    const assistant = messages.find((item) => item.role === 'assistant')
    expect(assistant?.content).toBe('候选甲全文')
    expect(new PatchService(db).list(project.id)).toHaveLength(0)
  })

  it('§4 ②③ insertion patch: proposed before body write, snapshot on accept, restore matches snapshot', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '插入补丁', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    const original = '风吹过旧码头。'
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: original })
    const service = new PatchService(db)
    // 插入型：fromPm === toPm，originalText 为空
    const patch = service.propose({
      projectId: project.id, documentId: chapter.id, documentRevision: 1,
      fromPm: 1, toPm: 1, originalText: '', replacement: '潮声渐近。'
    })
    expect(patch.status).toBe('proposed')
    expect(docs.getContent(project.id, chapter.id).plainText).toBe(original) // 正文尚未写入
    expect(service.prepare(project.id, patch.id, 1, '').status).toBe('proposed')
    const snapshots = docs.listSnapshots(project.id, chapter.id)
    expect(snapshots[0]?.reason).toBe('ai_edit')
    expect(snapshots[0]?.plainText).toBe(original)
    const saved = docs.saveContent({
      projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' },
      plainText: '潮声渐近。风吹过旧码头。', expectedRevision: 1
    })
    expect(service.complete(project.id, patch.id, saved.revision).status).toBe('accepted')
    expect(docs.getContent(project.id, chapter.id).plainText).toBe('潮声渐近。风吹过旧码头。')
    // ③ 撤销（恢复快照）后正文与快照一致
    const restored = docs.restoreSnapshot(project.id, snapshots[0]!.id)
    expect(restored.plainText).toBe(original)
    expect(docs.getContent(project.id, chapter.id).plainText).toBe(original)
  })

  it('only the selected candidate becomes a proposed patch; unselected candidates are not persisted', async () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '选中才写库', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '原文。' })
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: '本地', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'local', displayName: '本地', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    const queue = ['不写库甲', '写库乙', '不写库丙']
    let i = 0
    const runtime = new AICreativeRuntime(db, providers, () => ({
      chat: async function* () { yield queue[i++] ?? 'x' }
    }))
    const thread = new ChatService(db).createThread(project.id, '选中')
    let candidates: string[] | undefined
    for await (const event of runtime.run('r-sel', {
      mode: 'generation', writePermission: 'proposal', userIntent: '续', projectId: project.id, documentId: chapter.id, candidateCount: 3
    }, thread.id, 'u', 'a')) {
      if (event.candidates) candidates = event.candidates
    }
    expect(candidates).toEqual(['不写库甲', '写库乙', '不写库丙'])
    expect(new PatchService(db).list(project.id)).toHaveLength(0)
    // 模拟作者选中第 2 个候选 → 才 propose
    const selected = candidates![1]
    const patch = new PatchService(db).propose({
      projectId: project.id, documentId: chapter.id, documentRevision: 1,
      fromPm: 1, toPm: 1, originalText: '', replacement: selected
    })
    const listed = new PatchService(db).list(project.id)
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(patch.id)
    expect(listed[0].replacement).toBe('写库乙')
    expect(listed.some((item) => item.replacement === '不写库甲')).toBe(false)
    expect(listed.some((item) => item.replacement === '不写库丙')).toBe(false)
  })

  it('assistant helpers switch active candidate and gate patch propose', () => {
    const target = {
      requestId: 'r', projectId: 'p', documentId: 'd', sourceRevision: 1,
      selection: { fromPm: 1, toPm: 1, text: '', originalHash: 'empty' }
    }
    const message = {
      id: 'a', role: 'assistant' as const, content: '甲', mode: 'generation' as const, createdAt: 1,
      candidates: ['甲', '乙', '丙'], activeCandidateIndex: 1, target
    }
    expect(activeCandidateText(message)).toBe('乙')
    expect(canProposeGenerationPatch(message)).toBe(true)
    expect(canProposeGenerationPatch({ ...message, inserted: true })).toBe(false)
    expect(canInsertCandidate({ ...message, target: { requestId: 'r', projectId: 'p', documentId: 'd', sourceRevision: 1 } })).toBe(true)
  })
})
