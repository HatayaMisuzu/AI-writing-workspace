import { describe, expect, it } from 'vitest'
import { ProofreadingRunner } from '../src/main/ai/proofreading-runner'
import { ProviderService } from '../src/main/ai/provider'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectService } from '../src/main/services/project-service'
import { createTestDb, testCodec } from './helpers'
import { lintChineseText } from '../src/main/services/local-linter'

const configure = (): { runner: ProofreadingRunner; docs: DocumentService; projectId: string; chapterId: string } => {
  const db = createTestDb(); const project = new ProjectService(db).create({ title: '校对', projectType: 'novel' }); const docs = new DocumentService(db)
  const chapter = docs.listOrderedChapters(project.id)[0]
  docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '他慢慢的走进房间。' })
  const providers = new ProviderService(db, testCodec)
  providers.save({ id: 'p', providerType: 'openai-compatible', displayName: '测试', baseUrl: 'http://local', apiKey: 'k' })
  providers.saveModel({ id: 'm', providerId: 'p', modelId: 'm', displayName: '模型', enabled: true, isDefault: true, capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
  const runner = new ProofreadingRunner(db, providers, () => ({ complete: async () => JSON.stringify({ issues: [
    { category: 'grammar', originalText: '慢慢的走进', suggestion: '慢慢地走进', reason: '状语使用“地”' },
    { category: 'typo', originalText: '不存在的原文', suggestion: '错误', reason: '幻觉' }
  ] }) }))
  return { runner, docs, projectId: project.id, chapterId: chapter.id }
}

describe('proofreading runner', () => {
  it('returns actionable deterministic fixes for obvious local punctuation problems', () => {
    const input = '你好..  我来了。。 '
    const issues = lintChineseText(input)
    expect(issues.some((issue) => issue.replacement === '。')).toBe(true)
    const fixed = issues.toSorted((a, b) => b.from - a.from).reduce((text, issue) => issue.replacement === undefined ? text : `${text.slice(0, issue.from)}${issue.replacement}${text.slice(issue.to)}`, input)
    expect(fixed).toBe('你好。  我来了。 ')
  })

  it('returns only grounded suggestions and never modifies the document', async () => {
    const { runner, docs, projectId, chapterId } = configure(); const before = docs.getContent(projectId, chapterId)
    const issues = await runner.run(projectId, chapterId)
    expect(issues).toHaveLength(1); expect(issues[0].originalText).toBe('慢慢的走进')
    expect(docs.getContent(projectId, chapterId)).toEqual(before)
  })
})
