import { describe, expect, it } from 'vitest'
import { ChatService } from '../src/main/services/chat-service'
import { ProjectService } from '../src/main/services/project-service'
import { createTestDb } from './helpers'

describe('chat persistence', () => {
  it('keeps threads and messages isolated, paginated and restart-safe', () => {
    const db = createTestDb(); const projects = new ProjectService(db)
    const a = projects.create({ title: '甲', projectType: 'novel' }); const b = projects.create({ title: '乙', projectType: 'novel' })
    const chat = new ChatService(db); const thread = chat.createThread(a.id, '写作讨论')
    chat.startTurn({ projectId: a.id, threadId: thread.id, userMessageId: 'u', assistantMessageId: 'a', content: '继续写', mode: 'generation' })
    chat.updateAssistant(a.id, thread.id, 'a', '候选正文', 'complete')
    expect(new ChatService(db).listMessages(a.id, thread.id)).toMatchObject([
      { id: 'u', status: 'complete', content: '继续写' }, { id: 'a', status: 'complete', content: '候选正文' }
    ])
    const named = chat.createThread(a.id, '新对话')
    chat.startTurn({ projectId: a.id, threadId: named.id, userMessageId: 'u2', assistantMessageId: 'a2', content: '讨论钟楼钥匙与红伞的关系', mode: 'discussion' })
    expect(chat.listThreads(a.id).find((item) => item.id === named.id)?.title).toBe('讨论钟楼钥匙与红伞的关系')
    for (let index = 0; index < 13; index += 1) chat.createThread(a.id, `历史对话 ${index + 1}`)
    expect(chat.listThreads(a.id)).toHaveLength(15)
    expect(chat.listThreads(b.id)).toHaveLength(0)
    expect(() => chat.listMessages(b.id, thread.id)).toThrow('CHAT_THREAD_NOT_FOUND_IN_PROJECT')
  })

  it('converts abandoned streaming rows to an explicit error on migration', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '恢复', projectType: 'novel' })
    const chat = new ChatService(db); const thread = chat.createThread(project.id)
    chat.startTurn({ projectId: project.id, threadId: thread.id, userMessageId: 'u', assistantMessageId: 'a', content: '问题', mode: 'discussion' })
    db.raw.prepare("UPDATE chat_messages SET status = 'error' WHERE status = 'streaming'").run()
    expect(chat.listMessages(project.id, thread.id)[1].status).toBe('error')
  })
})
