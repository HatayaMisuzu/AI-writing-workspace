import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { ChapterDigestRunner } from '../src/main/ai/digest-runner'
import { MemoryIntentRunner } from '../src/main/ai/memory-intent'
import { ProofreadingRunner } from '../src/main/ai/proofreading-runner'
import { ProviderService, type ProviderMessage } from '../src/main/ai/provider'
import { StyleEngine } from '../src/main/ai/style-engine'
import { BackupService } from '../src/main/services/backup-service'
import { ChatService } from '../src/main/services/chat-service'
import { DocumentService } from '../src/main/services/document-service'
import { MemoryService } from '../src/main/services/memory-service'
import { PatchService } from '../src/main/services/patch-service'
import { ProjectContentService } from '../src/main/services/project-content-service'
import { ProjectService } from '../src/main/services/project-service'
import { createTestDb, testCodec } from './helpers'

describe('complete local writing loop', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

  it('uses a deterministic provider through writing, context, review, history and export', async () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '完整闭环', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]
    let content = docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '风从门缝里进来。'.repeat(12) })
    const contentService = new ProjectContentService(db)
    contentService.saveCharacter({ projectId: project.id, name: '林夏', notes: '谨慎，怕黑' })
    contentService.saveNote({ projectId: project.id, section: 'story', title: '旧屋', content: '屋门一直有一道缝。' })

    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: '确定性本地服务', baseUrl: 'http://deterministic.local/v1', apiKey: 'local-test-key' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'writer', displayName: '确定性模型', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    const outputs = ['先让林夏留在门外观察。', '我记得屋门一直有一道缝，可以让她利用这点。', '风沿着门缝钻进来。']
    const captured: ProviderMessage[][] = []
    const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function* (input) {
      captured.push(input.messages); yield outputs.shift() ?? '完成'
    } }))
    const thread = new ChatService(db).createThread(project.id, '闭环讨论')
    const run = async (requestId: string, userMessageId: string, assistantMessageId: string, mode: 'discussion' | 'generation', intent: string): Promise<string> => {
      let result = ''
      for await (const event of runtime.run(requestId, { mode, writePermission: mode === 'generation' ? 'proposal' : 'none', userIntent: intent, projectId: project.id, documentId: chapter.id }, thread.id, userMessageId, assistantMessageId)) result += event.chunk
      return result
    }
    await run('r1', 'u1', 'a1', 'discussion', '林夏现在该怎么办？')

    const proposed = await new MemoryIntentRunner(db, providers, () => ({ complete: async () => JSON.stringify({ shouldPropose: true,
      proposals: [{ type: 'fact', content: '屋门一直有一道缝', confidence: 0.99 }] }) })).extractAndCreate(project.id, 'u-memory', '就这么定，屋门一直有一道缝，这个记一下。')
    expect(proposed).toHaveLength(1)
    expect(new MemoryService(db).list(project.id).filter((item) => item.status === 'confirmed')).toHaveLength(0)
    new MemoryService(db).confirm(project.id, proposed[0].id, 'user')
    await run('r2', 'u2', 'a2', 'discussion', '屋门的缝能怎么利用？')
    expect(JSON.stringify(captured.at(-1))).toContain('屋门一直有一道缝')

    const digestRaw = JSON.stringify({ summary: '林夏在旧屋门外观察。', events: [], characterChanges: [], reveals: [], openQuestions: [], memoryCandidates: [], possibleContradictions: [] })
    await new ChapterDigestRunner(db, providers, () => ({ complete: async () => digestRaw })).run(project.id, chapter.id)
    const candidate = await run('r3', 'u3', 'a3', 'generation', '续写一句')
    const patches = new PatchService(db)
    const patch = patches.propose({ projectId: project.id, documentId: chapter.id, documentRevision: content.revision, fromPm: 1, toPm: 10, originalText: content.plainText, replacement: candidate })
    expect(patches.prepare(project.id, patch.id, content.revision, content.plainText).status).toBe('proposed')
    content = docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: candidate, expectedRevision: content.revision, styleSample: { origin: 'ai', text: candidate } })
    expect(patches.complete(project.id, patch.id, content.revision).status).toBe('accepted')
    expect(new StyleEngine(db).retrieve(project.id).some((sample) => sample.origin === 'ai')).toBe(false)

    const proofreader = new ProofreadingRunner(db, providers, () => ({ complete: async () => JSON.stringify({ issues: [{ category: 'repetition', originalText: '门缝', suggestion: '缝隙', reason: '避免重复', confidence: 0.9 }] }) }))
    const proofreadIssues = await proofreader.run(project.id, chapter.id)
    expect(proofreadIssues).toHaveLength(1); expect(docs.getContent(project.id, chapter.id).plainText).toBe(candidate)
    docs.createSnapshot(project.id, chapter.id, 'manual')
    expect(docs.listSnapshots(project.id, chapter.id).some((snapshot) => snapshot.reason === 'ai_edit')).toBe(true)

    const dir = await mkdtemp(join(tmpdir(), 'inkstone-loop-')); dirs.push(dir); const output = join(dir, 'manuscript.md')
    await new BackupService(db).exportManuscript(project.id, output, 'md')
    const exported = await readFile(output, 'utf8')
    expect(exported).toContain(candidate); expect(exported).not.toContain('屋门一直有一道缝')
    expect(new ChatService(db).listMessages(project.id, thread.id)).toHaveLength(6)
    expect(new MemoryService(db).list(project.id).filter((item) => item.status === 'confirmed')).toHaveLength(1)
  })
})
