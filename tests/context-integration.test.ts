import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectContentService } from '../src/main/services/project-content-service'
import { ChapterDigestService } from '../src/main/ai/chapter-digest-service'
import { ContextEngine } from '../src/main/ai/context-engine'
import { MemoryService } from '../src/main/services/memory-service'

describe('context engine source integration', () => {
  it('retrieves relevant character, story note, digest and memory without unrelated characters', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '上下文', projectType: 'novel' }); const docs = new DocumentService(db)
    const first = docs.listOrderedChapters(project.id)[0]; const volume = docs.listTree(project.id).find((node) => node.type === 'volume')!
    docs.saveContent({ projectId: project.id, documentId: first.id, editorJson: { type: 'doc' }, plainText: '周青带着红伞离开。' })
    new ChapterDigestService(db).storeFromModel(project.id, first.id, JSON.stringify({ summary: '周青在第3章拿走钥匙', events: [], characterChanges: [], reveals: [], openQuestions: [], memoryCandidates: [], possibleContradictions: [] }))
    const current = docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: '下一章' })
    docs.saveContent({ projectId: project.id, documentId: current.id, editorJson: { type: 'doc' }, plainText: '林夏站在电梯前。' })
    const content = new ProjectContentService(db)
    content.saveCharacter({ projectId: project.id, name: '林夏', aliases: ['小夏'], notes: '害怕密闭空间' })
    content.saveCharacter({ projectId: project.id, name: '无关人物', notes: '喜欢晴天' })
    content.saveNote({ projectId: project.id, section: 'story', title: '红伞归属', content: '红伞属于周青' })
    const memory = new MemoryService(db).create({ projectId: project.id, type: 'fact', content: '林夏曾被困在密室', status: 'suggested', sourceType: 'author', sourceId: 'a' })
    new MemoryService(db).confirm(project.id, memory.id, 'user')
    const bundle = new ContextEngine(db).build({ mode: 'discussion', writePermission: 'none', userIntent: '林夏进电梯会怎么样，周青的红伞和钥匙呢？', projectId: project.id, documentId: current.id })
    const serialized = JSON.stringify(bundle)
    expect(serialized).toContain('害怕密闭空间'); expect(serialized).not.toContain('喜欢晴天')
    expect(serialized).toContain('红伞属于周青'); expect(serialized).toContain('周青在第3章拿走钥匙'); expect(serialized).toContain('林夏曾被困在密室')
  })

  it('adds human-priority style only to generation/editing', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '风格', projectType: 'novel' }); const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '这是作者亲手写下的、足够长的一段安静文字。' })
    const engine = new ContextEngine(db)
    const discussion = engine.build({ mode: 'discussion', writePermission: 'none', userIntent: '讨论这一段', projectId: project.id, documentId: chapter.id })
    const generation = engine.build({ mode: 'generation', writePermission: 'none', userIntent: '续写这一段', projectId: project.id, documentId: chapter.id })
    expect(discussion.items.some((item) => item.kind === 'style')).toBe(false)
    expect(generation.items.some((item) => item.kind === 'style' && item.title.includes('human'))).toBe(true)
  })

  it('uses volume then chapter order for nearby context regardless of UUID', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '顺序', projectType: 'novel' }); const docs = new DocumentService(db)
    const volume1 = docs.listTree(project.id).find((node) => node.type === 'volume')!; const first = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: first.id, editorJson: { type: 'doc' }, plainText: '第一卷第一章' })
    const second = docs.createNode({ projectId: project.id, parentId: volume1.id, type: 'chapter', title: '第一卷第二章' }); docs.saveContent({ projectId: project.id, documentId: second.id, editorJson: { type: 'doc' }, plainText: '第一卷第二章内容' })
    const volume2 = docs.createNode({ projectId: project.id, type: 'volume', title: '第二卷' }); const third = docs.createNode({ projectId: project.id, parentId: volume2.id, type: 'chapter', title: '第二卷第一章' }); docs.saveContent({ projectId: project.id, documentId: third.id, editorJson: { type: 'doc' }, plainText: '第二卷开篇' })
    expect(docs.listOrderedChapters(project.id).map((node) => node.id)).toEqual([first.id, second.id, third.id])
    const nearby = new ContextEngine(db).build({ mode: 'discussion', writePermission: 'none', userIntent: '回顾前文', projectId: project.id, documentId: third.id }).items.filter((item) => item.kind === 'nearby')
    expect(nearby.map((item) => item.id)).toEqual([second.id, first.id])
  })
})
