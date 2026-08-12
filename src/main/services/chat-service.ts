import { randomUUID } from 'node:crypto'
import type { AIMode, ChatMessage, ChatThread } from '../../shared/domain'
import type { AppDatabase } from '../database/database'

type ThreadRow = { id: string; project_id: string; title: string; created_at: number; updated_at: number }
type MessageRow = { id: string; thread_id: string; project_id: string; role: ChatMessage['role']; content: string; task_mode: AIMode; status: ChatMessage['status']; created_at: number }

const mapThread = (row: ThreadRow): ChatThread => ({ id: row.id, projectId: row.project_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at })
const mapMessage = (row: MessageRow): ChatMessage => ({ id: row.id, threadId: row.thread_id, projectId: row.project_id,
  role: row.role, content: row.content, taskMode: row.task_mode, status: row.status, createdAt: row.created_at })

export class ChatService {
  constructor(private readonly db: AppDatabase) {}

  listThreads(projectId: string): ChatThread[] {
    this.assertProject(projectId)
    return (this.db.raw.prepare('SELECT id, project_id, title, created_at, updated_at FROM chat_threads WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as ThreadRow[]).map(mapThread)
  }

  ensureMainThread(projectId: string): ChatThread {
    return this.listThreads(projectId)[0] ?? this.createThread(projectId, '创作讨论')
  }

  createThread(projectId: string, title = '新对话'): ChatThread {
    this.assertProject(projectId)
    const now = Date.now(); const id = randomUUID()
    this.db.raw.prepare('INSERT INTO chat_threads(id, project_id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, title.trim() || '新对话', '', now, now)
    return this.getThread(projectId, id)
  }

  listMessages(projectId: string, threadId: string, before?: number, limit = 50): ChatMessage[] {
    this.getThread(projectId, threadId)
    const safeLimit = Math.max(1, Math.min(100, limit))
    const rows = (before
      ? this.db.raw.prepare(`SELECT * FROM (SELECT id, thread_id, project_id, role, content, task_mode, status, created_at
          FROM chat_messages WHERE project_id = ? AND thread_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?)
          ORDER BY created_at ASC`).all(projectId, threadId, before, safeLimit)
      : this.db.raw.prepare(`SELECT * FROM (SELECT id, thread_id, project_id, role, content, task_mode, status, created_at
          FROM chat_messages WHERE project_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT ?)
          ORDER BY created_at ASC`).all(projectId, threadId, safeLimit)) as MessageRow[]
    return rows.map(mapMessage)
  }

  startTurn(input: { projectId: string; threadId: string; userMessageId: string; assistantMessageId: string; content: string; mode: AIMode }): void {
    this.getThread(input.projectId, input.threadId)
    const now = Date.now()
    this.db.transaction(() => {
      this.db.raw.prepare(`INSERT INTO chat_messages(id, thread_id, project_id, role, content, task_mode, status, created_at)
        VALUES (?, ?, ?, 'user', ?, ?, 'complete', ?)`).run(input.userMessageId, input.threadId, input.projectId, input.content, input.mode, now)
      this.db.raw.prepare(`INSERT INTO chat_messages(id, thread_id, project_id, role, content, task_mode, status, created_at)
        VALUES (?, ?, ?, 'assistant', '', ?, 'streaming', ?)`).run(input.assistantMessageId, input.threadId, input.projectId, input.mode, now + 1)
      this.db.raw.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ? AND project_id = ?').run(now + 1, input.threadId, input.projectId)
    })
  }

  updateAssistant(projectId: string, threadId: string, messageId: string, content: string, status: ChatMessage['status']): void {
    const result = this.db.raw.prepare(`UPDATE chat_messages SET content = ?, status = ?
      WHERE id = ? AND thread_id = ? AND project_id = ? AND role = 'assistant'`).run(content, status, messageId, threadId, projectId)
    if (Number(result.changes) !== 1) throw new Error('CHAT_ASSISTANT_MESSAGE_NOT_FOUND')
    this.db.raw.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ? AND project_id = ?').run(Date.now(), threadId, projectId)
  }

  private getThread(projectId: string, threadId: string): ChatThread {
    const row = this.db.raw.prepare('SELECT id, project_id, title, created_at, updated_at FROM chat_threads WHERE id = ? AND project_id = ?')
      .get(threadId, projectId) as ThreadRow | undefined
    if (!row) throw new Error('CHAT_THREAD_NOT_FOUND_IN_PROJECT')
    return mapThread(row)
  }

  private assertProject(projectId: string): void {
    if (!this.db.raw.prepare('SELECT 1 AS found FROM projects WHERE id = ?').get(projectId)) throw new Error('PROJECT_NOT_FOUND')
  }
}
