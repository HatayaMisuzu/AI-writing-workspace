import type { AITaskEnvelope, ContextBundle, ContextItem } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { DocumentService } from '../services/document-service'
import { MemoryService } from '../services/memory-service'

const estimateTokens = (text: string): number => Math.ceil(text.length / 2.2)

export class ContextEngine {
  private readonly documents: DocumentService
  private readonly memories: MemoryService

  constructor(private readonly db: AppDatabase) {
    this.documents = new DocumentService(db)
    this.memories = new MemoryService(db)
  }

  build(task: AITaskEnvelope, budget = 12_000): ContextBundle {
    if (task.mode === 'reader_review') {
      if (!task.throughChapterId) throw new Error('READER_CHAPTER_REQUIRED')
      return this.buildReader(task.projectId, task.throughChapterId, budget)
    }
    return this.buildCreative(task, budget)
  }

  private buildCreative(task: AITaskEnvelope, budget: number): ContextBundle {
    const candidates: Array<ContextItem & { priority: number }> = []
    if (task.selection?.text) {
      candidates.push({ id: `selection:${task.documentId ?? 'unknown'}`, kind: 'selection', title: '当前选区',
        content: task.selection.text, projectId: task.projectId, reason: '用户当前选中的目标文本', priority: 100 })
    }
    if (task.documentId) {
      const current = this.documents.getContent(task.projectId, task.documentId)
      const node = this.documents.listTree(task.projectId).find((item) => item.id === task.documentId)
      candidates.push({ id: current.documentId, kind: 'document', title: node?.title ?? '当前文档', content: current.plainText,
        projectId: task.projectId, reason: '当前正在编辑的文档', priority: 90 })
      const chapters = this.documents.listTree(task.projectId).filter((item) => item.type === 'chapter')
      const index = chapters.findIndex((item) => item.id === task.documentId)
      for (const nearby of chapters.slice(Math.max(0, index - 2), index).reverse()) {
        const content = this.documents.getContent(task.projectId, nearby.id)
        candidates.push({ id: nearby.id, kind: 'nearby', title: nearby.title, content: content.plainText,
          projectId: task.projectId, reason: '当前章的邻近前文', priority: 65 })
      }
    }
    for (const memory of this.memories.list(task.projectId, ['confirmed', 'observed', 'tentative', 'idea', 'suggested'], task.userIntent.slice(0, 40))) {
      const stateWeight = memory.status === 'confirmed' ? 85 : memory.status === 'observed' ? 78 : memory.status === 'tentative' ? 55 : 40
      candidates.push({ id: memory.id, kind: 'memory', title: `${memory.type} · ${memory.status}`, content: memory.content,
        projectId: task.projectId, reason: `相关长期记忆，状态为 ${memory.status}`, priority: stateWeight })
    }
    for (const result of this.documents.search(task.projectId, task.userIntent, 8)) {
      candidates.push({ id: result.documentId, kind: 'search', title: result.title, content: result.snippet.replace(/<\/?mark>/g, ''),
        projectId: task.projectId, reason: '全文检索命中', priority: 60 - Math.min(20, Math.abs(result.rank)) })
    }
    const ideas = this.db.raw.prepare('SELECT id, content FROM ideas WHERE project_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 6')
      .all(task.projectId, 'active') as Array<{ id: string; content: string }>
    ideas.forEach((idea) => candidates.push({ id: idea.id, kind: 'note', title: '相关灵感', content: idea.content,
      projectId: task.projectId, reason: '当前作品的未归档灵感', priority: 35 }))
    const messages = this.db.raw.prepare('SELECT id, content, role FROM chat_messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 8')
      .all(task.projectId) as Array<{ id: string; content: string; role: string }>
    messages.reverse().forEach((message) => candidates.push({ id: message.id, kind: 'conversation', title: message.role,
      content: message.content, projectId: task.projectId, reason: '当前作品的最近对话', priority: 25 }))

    return this.budget(task.projectId, 'creative', candidates, budget, [])
  }

  buildReader(projectId: string, throughChapterId: string, budget = 12_000): ContextBundle {
    const ordered = this.db.raw.prepare(`
      SELECT c.id, c.title, dc.plain_text, v.order_index AS volume_order, c.order_index AS chapter_order
      FROM document_nodes c JOIN document_nodes v ON v.id = c.parent_id
      JOIN document_contents dc ON dc.document_id = c.id
      WHERE c.project_id = ? AND c.type = 'chapter'
      ORDER BY v.order_index, c.order_index
    `).all(projectId) as Array<{ id: string; title: string; plain_text: string; volume_order: number; chapter_order: number }>
    const throughIndex = ordered.findIndex((chapter) => chapter.id === throughChapterId)
    if (throughIndex < 0) throw new Error('READER_CHAPTER_NOT_FOUND_IN_PROJECT')
    const candidates: Array<ContextItem & { priority: number }> = ordered.slice(0, throughIndex + 1).map((chapter, index) => ({
      id: chapter.id, kind: 'document', title: chapter.title, content: chapter.plain_text, projectId,
      reason: `读者截至第 ${throughIndex + 1} 章可见的正文`, priority: 60 + index
    }))
    const visibleMemories = this.db.raw.prepare(`
      SELECT * FROM memories WHERE project_id = ? AND reader_visible_from IS NOT NULL AND reader_visible_from <= ?
        AND status IN ('observed','confirmed') ORDER BY reader_visible_from, updated_at
    `).all(projectId, throughIndex + 1) as Array<Record<string, unknown>>
    visibleMemories.forEach((memory) => candidates.push({
      id: memory.id as string, kind: 'memory', title: '读者可见信息', content: memory.content as string, projectId,
      reason: `readerVisibleFrom=${memory.reader_visible_from as number}`, priority: 75
    }))
    return this.budget(projectId, 'reader', candidates, budget, ['future_chapters', 'private_memory', 'creative_chat', 'ideas', 'future_plan'])
  }

  private budget(projectId: string, policy: ContextBundle['policy'], candidates: Array<ContextItem & { priority: number }>, maxTokens: number, excludedKinds: string[]): ContextBundle {
    const sorted = candidates.toSorted((a, b) => b.priority - a.priority)
    const items: ContextItem[] = []
    let estimatedTokens = 0
    const seen = new Set<string>()
    for (const { priority: _priority, ...item } of sorted) {
      const key = `${item.kind}:${item.id}`
      if (seen.has(key) || item.projectId !== projectId) continue
      const itemTokens = estimateTokens(item.content)
      if (items.length > 0 && estimatedTokens + itemTokens > maxTokens) continue
      items.push(item)
      seen.add(key)
      estimatedTokens += itemTokens
    }
    return { projectId, policy, items, metadata: { estimatedTokens, sourceIds: items.map((item) => item.id), excludedKinds } }
  }
}
