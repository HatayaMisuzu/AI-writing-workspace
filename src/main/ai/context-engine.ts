import type { AITaskEnvelope, Character, ContextBundle, ContextItem, ProjectNote } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { DocumentService } from '../services/document-service'
import { MemoryService } from '../services/memory-service'
import { StyleEngine } from './style-engine'
import { relevanceScore } from './relevance'

const estimateTokens = (text: string): number => Math.ceil(text.length / 2.2)

export class ContextEngine {
  private readonly documents: DocumentService
  private readonly memories: MemoryService
  private readonly styles: StyleEngine

  constructor(private readonly db: AppDatabase) {
    this.documents = new DocumentService(db)
    this.memories = new MemoryService(db)
    this.styles = new StyleEngine(db)
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
    let currentText = ''
    if (task.selection?.text) candidates.push({ id: `selection:${task.documentId ?? 'unknown'}`, kind: 'selection', title: '当前选区',
      content: task.selection.text, projectId: task.projectId, reason: '用户当前选中的目标文本', priority: 100 })

    const ordered = this.documents.listOrderedChapters(task.projectId)
    if (task.documentId) {
      const current = this.documents.getContent(task.projectId, task.documentId)
      currentText = current.plainText
      const node = ordered.find((item) => item.id === task.documentId) ?? this.documents.listTree(task.projectId).find((item) => item.id === task.documentId)
      candidates.push({ id: current.documentId, kind: 'document', title: node?.title ?? '当前文档', content: current.plainText,
        projectId: task.projectId, reason: '当前正在编辑的文档', priority: 95 })
      const index = ordered.findIndex((item) => item.id === task.documentId)
      if (index >= 0) for (const nearby of ordered.slice(Math.max(0, index - 2), index).reverse()) {
        const content = this.documents.getContent(task.projectId, nearby.id)
        candidates.push({ id: nearby.id, kind: 'nearby', title: nearby.title, content: content.plainText,
          projectId: task.projectId, reason: '按卷章故事顺序选择的邻近前文', priority: 65 })
      }
    }

    const signal = [task.userIntent, task.selection?.text ?? '', currentText].filter(Boolean).join('\n')
    for (const memory of this.memories.searchRelevant(task.projectId, ['confirmed', 'observed', 'tentative', 'idea', 'suggested'], signal)) {
      const stateWeight = memory.status === 'confirmed' ? 85 : memory.status === 'observed' ? 78 : memory.status === 'tentative' ? 55 : 40
      candidates.push({ id: memory.id, kind: 'memory', title: `${memory.type} · ${memory.status}`, content: memory.content,
        projectId: task.projectId, reason: `关键词相关的长期记忆，状态为 ${memory.status}`, priority: stateWeight })
    }

    this.addCharacters(task.projectId, signal, candidates)
    this.addNotes(task.projectId, signal, task.mode, candidates)
    this.addDigests(task.projectId, task.documentId, signal, candidates)

    if (task.userIntent.trim().length >= 2) {
      for (const result of this.documents.search(task.projectId, task.userIntent, 8)) candidates.push({
        id: result.documentId, kind: 'search', title: result.title, content: result.snippet.replace(/<\/?mark>/g, ''),
        projectId: task.projectId, reason: '当前作品全文检索命中', priority: 58 - Math.min(20, Math.abs(result.rank))
      })
    }

    if (!['chapter_digest', 'proofreading'].includes(task.mode)) {
      const ideas = this.db.raw.prepare('SELECT id, content FROM ideas WHERE project_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 20')
        .all(task.projectId, 'active') as Array<{ id: string; content: string }>
      ideas.map((idea) => ({ idea, score: relevanceScore(idea.content, signal) })).filter((item) => item.score > 0).slice(0, 6)
        .forEach(({ idea, score }) => candidates.push({ id: idea.id, kind: 'note', title: '相关灵感', content: idea.content,
          projectId: task.projectId, reason: '当前作品的相关未归档灵感', priority: 34 + score }))
    }

    if (task.mode === 'generation' || task.mode === 'editing') {
      this.styles.retrieve(task.projectId).forEach((sample) => candidates.push({ id: sample.id, kind: 'style', title: `风格样本 · ${sample.origin}`,
        content: sample.text, projectId: task.projectId, reason: '生成或编辑任务的人类优先风格样本', priority: 50 + Math.round(sample.score / 10) }))
    }

    return this.budget(task.projectId, 'creative', candidates, budget, ['other_projects'])
  }

  private addCharacters(projectId: string, signal: string, candidates: Array<ContextItem & { priority: number }>): void {
    const rows = this.db.raw.prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Array<Record<string, unknown>>
    rows.map((row) => ({
      character: { id: row.id as string, projectId, name: row.name as string, aliases: JSON.parse(row.aliases_json as string) as string[],
        notes: row.notes as string, fields: JSON.parse(row.fields_json as string) as Record<string, string>, createdAt: row.created_at as number, updatedAt: row.updated_at as number } satisfies Character,
      matched: [row.name as string, ...(JSON.parse(row.aliases_json as string) as string[])].some((name) => name && signal.includes(name))
    })).filter((item) => item.matched).slice(0, 8).forEach(({ character }) => candidates.push({
      id: character.id, kind: 'character', title: `人物 · ${character.name}`,
      content: [character.aliases.length ? `别名：${character.aliases.join('、')}` : '', character.notes, JSON.stringify(character.fields)].filter(Boolean).join('\n'),
      projectId, reason: '问题、选区或当前章明确提及该人物', priority: 82
    }))
  }

  private addNotes(projectId: string, signal: string, mode: AITaskEnvelope['mode'], candidates: Array<ContextItem & { priority: number }>): void {
    const rows = this.db.raw.prepare('SELECT * FROM project_notes WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Array<Record<string, unknown>>
    rows.map((row) => ({ note: { id: row.id as string, projectId, section: row.section as ProjectNote['section'], title: row.title as string,
      content: row.content as string, createdAt: row.created_at as number, updatedAt: row.updated_at as number }, score: relevanceScore(`${row.title as string}\n${row.content as string}`, signal) }))
      .filter(({ note, score }) => score > 0 && (note.section === 'story' || /参考|资料|来源|背景/.test(signal) || mode === 'discussion'))
      .toSorted((a, b) => b.score - a.score).slice(0, 8).forEach(({ note, score }) => candidates.push({ id: note.id,
        kind: note.section === 'story' ? 'note' : 'reference', title: note.title, content: note.content, projectId,
        reason: note.section === 'story' ? '相关故事笔记' : '按需召回的相关参考资料', priority: 60 + score }))
  }

  private addDigests(projectId: string, documentId: string | undefined, signal: string, candidates: Array<ContextItem & { priority: number }>): void {
    const ordered = this.documents.listOrderedChapters(projectId)
    const currentIndex = documentId ? ordered.findIndex((chapter) => chapter.id === documentId) : ordered.length
    const allowed = new Set(ordered.slice(0, currentIndex < 0 ? ordered.length : currentIndex).map((chapter) => chapter.id))
    const rows = this.db.raw.prepare('SELECT id, chapter_id, summary, created_at FROM chapter_digests WHERE project_id = ? AND stale = 0 ORDER BY created_at DESC')
      .all(projectId) as Array<{ id: string; chapter_id: string; summary: string; created_at: number }>
    rows.filter((row) => allowed.has(row.chapter_id)).map((row, index) => ({ row, score: relevanceScore(row.summary, signal), recent: index < 2 }))
      .filter((item) => item.score > 0 || item.recent).slice(0, 6).forEach(({ row, score }) => candidates.push({ id: row.id,
        kind: 'digest', title: '前文章节理解', content: row.summary, projectId, reason: '非陈旧的前章摘要', priority: 57 + score }))
  }

  buildReader(projectId: string, throughChapterId: string, budget = 12_000): ContextBundle {
    const ordered = this.db.raw.prepare(`
      SELECT c.id, c.title, dc.plain_text
      FROM document_nodes c JOIN document_nodes v ON v.id = c.parent_id AND v.project_id = c.project_id
      JOIN document_contents dc ON dc.document_id = c.id AND dc.project_id = c.project_id
      WHERE c.project_id = ? AND c.type = 'chapter' AND v.type = 'volume'
      ORDER BY v.order_index, c.order_index, c.created_at
    `).all(projectId) as Array<{ id: string; title: string; plain_text: string }>
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
    visibleMemories.forEach((memory) => candidates.push({ id: memory.id as string, kind: 'memory', title: '读者可见信息',
      content: memory.content as string, projectId, reason: `readerVisibleFrom=${memory.reader_visible_from as number}`, priority: 75 }))
    return this.budget(projectId, 'reader', candidates, budget, ['future_chapters', 'private_memory', 'creative_chat', 'ideas', 'future_plan', 'story_notes', 'references', 'digests'])
  }

  private budget(projectId: string, policy: ContextBundle['policy'], candidates: Array<ContextItem & { priority: number }>, maxTokens: number, excludedKinds: string[]): ContextBundle {
    const sorted = candidates.toSorted((a, b) => b.priority - a.priority)
    const items: ContextItem[] = []
    let estimatedTokens = 0
    const seen = new Set<string>()
    for (const { priority, ...item } of sorted) {
      void priority
      const key = `${item.kind}:${item.id}`
      if (seen.has(key) || item.projectId !== projectId) continue
      const itemTokens = estimateTokens(item.content)
      if (items.length > 0 && estimatedTokens + itemTokens > maxTokens) continue
      items.push(item); seen.add(key); estimatedTokens += itemTokens
    }
    return { projectId, policy, items, metadata: { estimatedTokens, sourceIds: items.map((item) => item.id), excludedKinds } }
  }
}
