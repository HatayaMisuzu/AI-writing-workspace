import { describe, expect, it } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ProviderService } from '../src/main/ai/provider'
import { ChapterDigestRunner } from '../src/main/ai/digest-runner'

const validDigest = JSON.stringify({ summary: '周青拿走钥匙。', events: ['拿走钥匙'], characterChanges: [], reveals: [], openQuestions: [],
  memoryCandidates: [{ type: 'event', content: '周青拿走钥匙', confidence: 0.8 }], possibleContradictions: [] })

const setup = () => {
  const db = createTestDb(); const project = new ProjectService(db).create({ title: '摘要链路', projectType: 'novel' })
  const chapter = new DocumentService(db).listOrderedChapters(project.id)[0]
  new DocumentService(db).saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '周青从桌上拿走钥匙。' })
  const providers = new ProviderService(db, testCodec); const provider = providers.save({ id: 'p', providerType: 'openai-compatible', displayName: '本地测试', baseUrl: 'http://local.test/v1', apiKey: 'unused' })
  providers.saveModel({ id: 'm', providerId: provider.id, modelId: 'local', displayName: 'Local', capabilities: { streaming: true, cancellation: true, tools: false, structuredOutput: false }, enabled: true, isDefault: true })
  return { db, project, chapter, providers }
}

describe('chapter digest runner', () => {
  it('stores valid and fenced JSON while keeping candidates suggested', async () => {
    for (const raw of [validDigest, `\`\`\`json\n${validDigest}\n\`\`\``]) {
      const { db, project, chapter, providers } = setup()
      const result = await new ChapterDigestRunner(db, providers, () => ({ complete: async () => raw })).run(project.id, chapter.id)
      expect(result.repaired).toBe(false)
      expect((db.raw.prepare('SELECT summary FROM chapter_digests').get() as { summary: string }).summary).toContain('钥匙')
      expect((db.raw.prepare('SELECT status FROM memories').get() as { status: string }).status).toBe('suggested')
    }
  })

  it('repairs malformed output once and then stores it', async () => {
    const { db, project, chapter, providers } = setup(); const outputs = ['not json', validDigest]
    const result = await new ChapterDigestRunner(db, providers, () => ({ complete: async () => outputs.shift()! })).run(project.id, chapter.id)
    expect(result.repaired).toBe(true); expect(outputs).toHaveLength(0)
  })

  it('surfaces two malformed outputs without changing the chapter', async () => {
    const { db, project, chapter, providers } = setup(); const before = new DocumentService(db).getContent(project.id, chapter.id)
    const runner = new ChapterDigestRunner(db, providers, () => ({ complete: async () => 'still malformed' }))
    await expect(runner.run(project.id, chapter.id)).rejects.toMatchObject({ code: 'DIGEST_INVALID_RESPONSE' })
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM chapter_digests').get()).toEqual({ count: 0 })
    expect(new DocumentService(db).getContent(project.id, chapter.id)).toEqual(before)
  })
})
