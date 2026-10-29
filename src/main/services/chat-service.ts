import { randomUUID } from 'node:crypto'
import type { AIMode, ChatCursor, ChatMessage, ChatThread, DocumentTaskTarget } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { consistencyCoverage } from '../../shared/consistency-check'

type ThreadRow = { id: string; project_id: string; title: string; created_at: number; updated_at: number }
type MessageRow = { id: string; thread_id: string; project_id: string; role: ChatMessage['role']; content: string; task_mode: AIMode; status: ChatMessage['status']; context_snapshot_json: string | null; created_at: number }

const mapThread = (row: ThreadRow): ChatThread => ({ id: row.id, projectId: row.project_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at })
const mapMessage = (row: MessageRow): ChatMessage => {
  const snapshot = row.context_snapshot_json ? JSON.parse(row.context_snapshot_json) as { target?: DocumentTaskTarget; sources?: Array<{ id: string; kind: string; truncated?: boolean }>; omitted?: Array<{ id: string; kind: string }> } : undefined
  return { id: row.id, threadId: row.thread_id, projectId: row.project_id,
    role: row.role, content: row.content, taskMode: row.task_mode, status: row.status, createdAt: row.created_at,
    target: snapshot?.target,
    // P1-6：一致性检查报告重启后仍能显示「未参与比对」警告与引用校验所需的章节 id
    ...(row.task_mode === 'consistency_check' && row.role === 'assistant' && snapshot?.sources ? { coverage: consistencyCoverage({ sources: snapshot.sources, omitted: snapshot.omitted ?? [] }) } : {}) }
}

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

  listMessages(projectId: string, threadId: string, before?: ChatCursor, limit = 50): ChatMessage[] {
    this.getThread(projectId, threadId)
    const safeLimit = Math.max(1, Math.min(100, limit))
    const rows = (before
      ? this.db.raw.prepare(`SELECT * FROM (SELECT id, thread_id, project_id, role, content, task_mode, status, context_snapshot_json, created_at
          FROM chat_messages WHERE project_id = ? AND thread_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at ASC, id ASC`)
        .all(projectId, threadId, before.createdAt, before.createdAt, before.id, safeLimit)
      : this.db.raw.prepare(`SELECT * FROM (SELECT id, thread_id, project_id, role, content, task_mode, status, context_snapshot_json, created_at
          FROM chat_messages WHERE project_id = ? AND thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)
          ORDER BY created_at ASC, id ASC`).all(projectId, threadId, safeLimit)) as MessageRow[]
    return rows.map(mapMessage)
  }

  startTurn(input: { projectId: string; threadId: string; userMessageId: string; assistantMessageId: string; content: string; mode: AIMode; target?: DocumentTaskTarget; contextSnapshot?: { sources: Array<{ id: string; kind: string; truncated?: true }>; omitted: Array<{ id: string; kind: string; reason: string }> } }): void {
    this.getThread(input.projectId, input.threadId)
    const now = Date.now()
    this.db.transaction(() => {
      // S6：只记 id/类型/排除原因，不存正文
      const context = (input.target || input.contextSnapshot)
        ? JSON.stringify({ ...(input.target ? { target: input.target } : {}), ...(input.contextSnapshot ? { sources: input.contextSnapshot.sources, omitted: input.contextSnapshot.omitted } : {}) })
        : null
      this.db.raw.prepare(`INSERT INTO chat_messages(id, thread_id, project_id, role, content, task_mode, context_snapshot_json, status, created_at)
        VALUES (?, ?, ?, 'user', ?, ?, ?, 'complete', ?)`).run(input.userMessageId, input.threadId, input.projectId, input.content, input.mode, context, now)
      this.db.raw.prepare(`INSERT INTO chat_messages(id, thread_id, project_id, role, content, task_mode, context_snapshot_json, status, created_at)
        VALUES (?, ?, ?, 'assistant', '', ?, ?, 'streaming', ?)`).run(input.assistantMessageId, input.threadId, input.projectId, input.mode, context, now + 1)
      const title = [...input.content.trim()].slice(0, 22).join('') || '新对话'
      this.db.raw.prepare(`UPDATE chat_threads SET title = CASE WHEN title = '新对话' THEN ? ELSE title END,
        updated_at = ? WHERE id = ? AND project_id = ?`).run(title, now + 1, input.threadId, input.projectId)
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
