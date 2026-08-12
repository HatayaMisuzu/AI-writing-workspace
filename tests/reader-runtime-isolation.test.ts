import { describe, expect, it } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ContextEngine } from '../src/main/ai/context-engine'
import { ProviderService } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'

describe('reader final provider request isolation', () => {
  it('excludes future truth, private memory, ideas and creative chat from final messages', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '读者隔离', projectType: 'novel' })
    const docs = new DocumentService(db); const volume = docs.listTree(project.id).find((node) => node.type === 'volume')!
    const first = docs.listOrderedChapters(project.id)[0]
    const future = docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: '第十章' })
    docs.saveContent({ projectId: project.id, documentId: first.id, editorJson: { type: 'doc' }, plainText: '读者只看到雨夜。' })
    docs.saveContent({ projectId: project.id, documentId: future.id, editorJson: { type: 'doc' }, plainText: '第十章正文秘密：凶手=A。' })
    const memories = new MemoryService(db); const secret = memories.create({ projectId: project.id, type: 'fact', content: '凶手=A', status: 'suggested', sourceType: 'author', sourceId: 'private' }); memories.confirm(project.id, secret.id, 'user')
    db.raw.prepare(`INSERT INTO ideas(id,project_id,content,status,tags_json,created_at,updated_at) VALUES ('idea',?,'让 A 当凶手','active','[]',1,1)`).run(project.id)
    db.raw.prepare(`INSERT INTO chat_threads(id,project_id,title,created_at,updated_at) VALUES ('thread',?,'秘密讨论',1,1)`).run(project.id)
    db.raw.prepare(`INSERT INTO chat_messages(id,thread_id,project_id,role,content,task_mode,status,created_at) VALUES ('msg','thread',?,'user','A 就是凶手','discussion','complete',1)`).run(project.id)
    const task = { mode: 'reader_review' as const, writePermission: 'none' as const, userIntent: '读者现在会怎么理解？', projectId: project.id, throughChapterId: first.id }
    const context = new ContextEngine(db).build(task)
    const finalMessages = new AICreativeRuntime(db, new ProviderService(db, testCodec)).buildMessages(task, context, 'thread')
    const serialized = JSON.stringify(finalMessages)
    for (const forbidden of ['凶手=A', 'A 就是凶手', '让 A 当凶手', '第十章正文秘密']) expect(serialized).not.toContain(forbidden)
    expect(serialized).toContain('读者只看到雨夜')
  })
})
