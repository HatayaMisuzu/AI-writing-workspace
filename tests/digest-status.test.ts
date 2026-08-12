import { describe, expect, it } from 'vitest'
import { ChapterDigestService } from '../src/main/ai/chapter-digest-service'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectService } from '../src/main/services/project-service'
import { createTestDb } from './helpers'

describe('chapter digest status', () => {
  it('transitions missing -> fresh -> stale when正文 revision changes', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '理解', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]; const digests = new ChapterDigestService(db)
    expect(digests.status(project.id, chapter.id).state).toBe('missing')
    digests.storeFromModel(project.id, chapter.id, JSON.stringify({ summary: '开场', events: [], characterChanges: [], reveals: [], openQuestions: [], memoryCandidates: [], possibleContradictions: [] }))
    expect(digests.status(project.id, chapter.id).state).toBe('fresh')
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '正文变化' })
    expect(digests.status(project.id, chapter.id).state).toBe('stale')
    digests.storeFromModel(project.id, chapter.id, JSON.stringify({ summary: '更新后的理解', events: [], characterChanges: [], reveals: [], openQuestions: [], memoryCandidates: [], possibleContradictions: [] }))
    expect(digests.status(project.id, chapter.id).state).toBe('fresh')
  })
})
