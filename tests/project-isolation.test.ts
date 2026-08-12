import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { IdeaService, MemoryService } from '../src/main/services/memory-service'
import { ProjectContentService } from '../src/main/services/project-content-service'

describe('multi-project isolation', () => {
  const db = createTestDb()
  const projects = new ProjectService(db)
  const documents = new DocumentService(db)
  const ideas = new IdeaService(db)
  const memories = new MemoryService(db)
  afterEach(() => {
    db.raw.exec('DELETE FROM document_fts; DELETE FROM projects;')
  })

  it('rejects cross-project document reads and isolates FTS results', () => {
    const a = projects.create({ title: '雾港来信', projectType: 'novel' })
    const b = projects.create({ title: '山河记', projectType: 'novel' })
    const aChapter = documents.listTree(a.id).find((node) => node.type === 'chapter')!
    const bChapter = documents.listTree(b.id).find((node) => node.type === 'chapter')!
    documents.saveContent({ projectId: a.id, documentId: aChapter.id, editorJson: { type: 'doc' }, plainText: '红色雨伞藏在旧码头。' })
    documents.saveContent({ projectId: b.id, documentId: bChapter.id, editorJson: { type: 'doc' }, plainText: '红色雨伞是北境王族的徽记。' })

    expect(() => documents.getContent(a.id, bChapter.id)).toThrow('DOCUMENT_NOT_FOUND_IN_PROJECT')
    const results = documents.search(a.id, '红色雨伞')
    expect(results).toHaveLength(1)
    expect(results[0].projectId).toBe(a.id)
    expect(results[0].documentId).toBe(aChapter.id)
  })

  it('keeps ideas and memory queries inside their owning project', () => {
    const a = projects.create({ title: 'A', projectType: 'novel' })
    const b = projects.create({ title: 'B', projectType: 'novel' })
    ideas.create(a.id, 'A 的私密灵感')
    ideas.create(b.id, 'B 的私密灵感')
    memories.create({ projectId: a.id, type: 'decision', content: 'A 的秘密', status: 'suggested', sourceType: 'chat', sourceId: 'chat-a' })
    memories.create({ projectId: b.id, type: 'decision', content: 'B 的秘密', status: 'suggested', sourceType: 'chat', sourceId: 'chat-b' })
    expect(ideas.list(a.id).map((item) => item.content)).toEqual(['A 的私密灵感'])
    expect(memories.list(a.id).map((item) => item.content)).toEqual(['A 的秘密'])
  })

  it('isolates story notes, references and characters by project', () => {
    const a = projects.create({ title: 'A', projectType: 'novel' })
    const b = projects.create({ title: 'B', projectType: 'novel' })
    const content = new ProjectContentService(db)
    content.saveNote({ projectId: a.id, section: 'story', title: 'A 故事', content: 'A only' })
    content.saveNote({ projectId: b.id, section: 'story', title: 'B 故事', content: 'B only' })
    content.saveCharacter({ projectId: a.id, name: '同名人物', notes: '属于 A' })
    content.saveCharacter({ projectId: b.id, name: '同名人物', notes: '属于 B' })
    expect(content.listNotes(a.id, 'story').map((item) => item.content)).toEqual(['A only'])
    expect(content.listCharacters(a.id).map((item) => item.notes)).toEqual(['属于 A'])
  })
})
