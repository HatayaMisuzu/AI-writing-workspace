import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ContextEngine } from '../src/main/ai/context-engine'

describe('reader context isolation', () => {
  it('excludes future chapters, private confirmed memory, ideas and creative chat', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '谜案', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter1 = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    const volume = docs.listTree(project.id).find((node) => node.type === 'volume')!
    const chapter2 = docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: '第十章 真相' })
    docs.saveContent({ projectId: project.id, documentId: chapter1.id, editorJson: { type: 'doc' }, plainText: '第五章结束时，读者只知道雨夜有人失踪。' })
    docs.saveContent({ projectId: project.id, documentId: chapter2.id, editorJson: { type: 'doc' }, plainText: '未来揭露：凶手是 A。' })
    const memoryService = new MemoryService(db)
    const secret = memoryService.create({ projectId: project.id, type: 'decision', content: '凶手是 A', status: 'suggested', sourceType: 'author', sourceId: 'author' })
    memoryService.confirm(project.id, secret.id, 'user')
    db.raw.prepare(`INSERT INTO ideas(id,project_id,content,status,tags_json,created_at,updated_at) VALUES ('idea',?,'让 A 成为凶手','active','[]',1,1)`).run(project.id)
    db.raw.prepare(`INSERT INTO chat_threads(id,project_id,title,created_at,updated_at) VALUES ('thread',?,'私聊',1,1)`).run(project.id)
    db.raw.prepare(`INSERT INTO chat_messages(id,thread_id,project_id,role,content,task_mode,status,created_at) VALUES ('message','thread',?,'user','A 就是凶手','discussion','complete',1)`).run(project.id)

    const bundle = new ContextEngine(db).buildReader(project.id, chapter1.id)
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain('凶手是 A')
    expect(serialized).not.toContain('让 A 成为凶手')
    expect(serialized).not.toContain('A 就是凶手')
    expect(bundle.metadata.excludedKinds).toEqual(expect.arrayContaining(['future_chapters', 'private_memory', 'creative_chat', 'ideas']))
    expect(bundle.items.every((item) => item.projectId === project.id)).toBe(true)
  })

  it('allows only explicitly reader-visible memory through the requested chapter', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '可见性', projectType: 'novel' })
    const chapter = new DocumentService(db).listTree(project.id).find((node) => node.type === 'chapter')!
    new MemoryService(db).create({ projectId: project.id, type: 'fact', content: '读者看到红伞', status: 'observed', sourceType: 'chapter', sourceId: chapter.id, readerVisibleFrom: 1 })
    const bundle = new ContextEngine(db).buildReader(project.id, chapter.id)
    expect(JSON.stringify(bundle)).toContain('读者看到红伞')
  })
})
