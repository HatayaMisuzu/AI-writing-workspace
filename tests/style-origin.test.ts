import { describe, expect, it } from 'vitest'
import { StyleEngine } from '../src/main/ai/style-engine'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectService } from '../src/main/services/project-service'
import { StyleSampleService } from '../src/main/services/style-sample-service'
import { createTestDb } from './helpers'

describe('style origin safety', () => {
  it('records human writing and raw AI insertion with different origins, retrieving only safe samples', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '风格来源', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]
    const human = '作者独立写下的句子有自己的节奏。'.repeat(12)
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: human })
    const aiCandidate = '这是模型生成的一段候选文字，尚未经过作者修改。'
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: `${human}\n${aiCandidate}`, styleSample: { origin: 'ai', text: aiCandidate } })
    const stored = new StyleSampleService(db).list(project.id)
    expect(stored.some((sample) => sample.origin === 'human')).toBe(true)
    expect(stored.some((sample) => sample.origin === 'ai')).toBe(true)
    const retrieved = new StyleEngine(db).retrieve(project.id)
    expect(retrieved.some((sample) => sample.origin === 'human')).toBe(true)
    expect(retrieved.some((sample) => sample.origin === 'ai')).toBe(false)
  })
})
