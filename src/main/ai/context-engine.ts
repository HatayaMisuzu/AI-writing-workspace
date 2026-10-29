import { OVERFLOW_LIST_LIMIT, type AITaskEnvelope, type Character, type ContextBundle, type ContextItem, type ContextOmission, type ContextOverflow, type ProjectNote } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { DocumentService } from '../services/document-service'
import { MemoryService } from '../services/memory-service'
import { StyleEngine } from './style-engine'
import { relevanceScore } from './relevance'
import { validateReaderChapterNumber } from '../../shared/reader-review'
import { truncateBySide, truncationSideFor } from '../../shared/consistency-check'
import { compareSettingRank, memoryEntryNames, rankSetting, settingBasis, BASIS_LABELS, type SettingRank } from '../../shared/setting-order'

/** listTitle：只用于清单展示（作者排除行），不进入发送内容。 */
type Candidate = ContextItem & { priority: number; rank?: SettingRank; listTitle?: string }
/** P3-e：钉住的设定在创作类模式中排在选区之后、其余一切之前。 */
const PINNED_PRIORITY = 99
export const CONSISTENCY_MEMORY_LIMIT = 60
export const CONSISTENCY_CHARACTER_LIMIT = 40
export const CREATIVE_MEMORY_LIMIT = 12
export const CREATIVE_CHARACTER_LIMIT = 8
export const CONSISTENCY_TIMELINE_LIMIT = 200
export const OVERFLOW_BASIS = '超出上限未带上'

/** L4：上限外条目（已按现有规则排序）→ 清单可见的溢出行；只记 id / 标题 / 依据，不进入发送内容。 */
const overflowOf = (kind: ContextOverflow['kind'], label: string, limit: number, rest: Array<{ id: string; title: string; basis?: string[] }>): ContextOverflow[] =>
  rest.length ? [{ kind, label, limit, total: rest.length, listTruncated: rest.length > OVERFLOW_LIST_LIMIT,
    items: rest.slice(0, OVERFLOW_LIST_LIMIT).map((item) => ({ id: item.id, kind, title: item.title, basis: [...(item.basis ?? []), OVERFLOW_BASIS] })) }] : []

const estimateTokens = (text: string): number => Math.ceil(text.length / 2.2)
// M1/L4：数量上限只约束未钉住的条目；钉住的全部进入候选，只受预算裁剪（裁掉的照常标出）。
const withinLimitOrPinned = <T>(items: T[], limit: number, isPinned: (item: T) => boolean): { kept: T[]; rest: T[] } =>
  ({ kept: items.filter((item, index) => index < limit || isPinned(item)), rest: items.filter((item, index) => index >= limit && !isPinned(item)) })
const settingName = (content: string): string => { const flat = content.replace(/\s+/g, ' ').trim(); return [...flat].length > 16 ? `${[...flat].slice(0, 16).join('')}…` : flat || '未命名' }

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
      const through = task.throughChapterNumber ?? task.throughChapterId
      if (through === undefined) throw new Error('READER_CHAPTER_REQUIRED')
      return this.buildReader(task.projectId, through, budget, task.excludedIds)
    }
    if (task.mode === 'consistency_check') return this.buildConsistency(task, budget)
    return this.buildCreative(task, budget)
  }

  /**
   * P1-6 记录员·一致性检查：本章正文 + 已确认设定（confirmed 记忆，伏笔除外）+ 人物卡 + 时间线。
   * 待确认/暂定记忆、伏笔、灵感、大纲、摘要、他章与他书都不进。时间线仅在本模式进上下文。
   */
  private buildConsistency(task: AITaskEnvelope, budget: number): ContextBundle {
    if (!task.documentId) throw Object.assign(new Error('请先打开要检查的章节。'), { code: 'CONSISTENCY_CHAPTER_REQUIRED' })
    const { projectId } = task
    const chapter = this.documents.getContent(projectId, task.documentId)
    const node = this.documents.listTree(projectId).find((item) => item.id === task.documentId)
    const chapterItem: Candidate = { id: chapter.documentId, kind: 'document', title: `本章 · ${node?.title ?? '当前章节'}`,
      content: chapter.plainText, projectId, reason: '待检查的本章正文', priority: 100 }
    const candidates: Candidate[] = []
    // P3-e：本章相关 = 本章正文或当前选区出现条目名/别名（纯本地字符串匹配）
    const haystack = [chapter.plainText, task.selection?.text ?? ''].join('\n')
    const pinned = new Set(task.includedIds ?? [])
    const memories = this.db.raw.prepare("SELECT id, type, content, updated_at FROM memories WHERE project_id = ? AND status = 'confirmed' AND type != 'foreshadowing' ORDER BY updated_at DESC, id")
      .all(projectId) as Array<{ id: string; type: string; content: string; updated_at: number }>
    // P3-e M1：先对全部已确认设定按新规则排序，再截取上限（60 条），避免早期相关设定被 SQL LIMIT 先截掉
    const memoryCandidates: Candidate[] = []
    memories.forEach((memory) => {
      const rank = rankSetting({ id: memory.id, pinned: pinned.has(memory.id), confirmed: true, names: memoryEntryNames(memory.content), updatedAt: memory.updated_at }, haystack)
      memoryCandidates.push({ id: memory.id, kind: 'memory', title: `设定 · ${settingName(memory.content)}（${memory.type}）`, content: memory.content,
        projectId, reason: '作者已确认的设定', priority: 80, rank, basis: settingBasis(rank) })
    })
    const sortedMemories = memoryCandidates.toSorted((a, b) => compareSettingRank(a.rank!, b.rank!))
    const memorySplit = withinLimitOrPinned(sortedMemories, CONSISTENCY_MEMORY_LIMIT, (item) => pinned.has(item.id))
    candidates.push(...memorySplit.kept)
    const overflow: ContextOverflow[] = overflowOf('memory', '设定', CONSISTENCY_MEMORY_LIMIT, memorySplit.rest)
    const characters = this.db.raw.prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY updated_at DESC, id').all(projectId) as Array<Record<string, unknown>>
    // P3-e M1：人物卡同理，先排序再截取 40 条
    const characterCandidates: Candidate[] = []
    characters.forEach((row) => {
      const aliases = JSON.parse(row.aliases_json as string) as string[]
      const fields = JSON.parse(row.fields_json as string) as Record<string, string>
      const content = [aliases.length ? `别名：${aliases.join('、')}` : '', row.notes as string,
        ...Object.entries(fields).filter(([, value]) => value).map(([key, value]) => `${key}：${value}`)].filter(Boolean).join('\n')
      const rank = rankSetting({ id: row.id as string, pinned: pinned.has(row.id as string), confirmed: false, names: [row.name as string, ...aliases], updatedAt: row.updated_at as number }, haystack)
      characterCandidates.push({ id: row.id as string, kind: 'character', title: `人物 · ${row.name as string}`, content: content || '（无更多信息）',
        projectId, reason: '人物卡', priority: rank.mentioned ? 79 : 70, rank, basis: settingBasis(rank) })
    })
    const sortedCharacters = characterCandidates.toSorted((a, b) => compareSettingRank(a.rank!, b.rank!))
    const characterSplit = withinLimitOrPinned(sortedCharacters, CONSISTENCY_CHARACTER_LIMIT, (item) => pinned.has(item.id))
    candidates.push(...characterSplit.kept)
    overflow.push(...overflowOf('character', '人物卡', CONSISTENCY_CHARACTER_LIMIT, characterSplit.rest))
    const titles = new Map(this.documents.listTree(projectId).map((item) => [item.id, item.title]))
    // L4：取全部事件（顺序同 base）；前 200 条照旧，200 条之后只有钉住的进入候选，其余进溢出行。
    const allEvents = this.db.raw.prepare('SELECT id, story_time_label, title, chapter_id FROM timeline_events WHERE project_id = ? ORDER BY sort_key, created_at')
      .all(projectId) as Array<{ id: string; story_time_label: string; title: string; chapter_id: string | null }>
    const indexed = allEvents.map((event, index) => ({ event, index }))
    const events = indexed.filter(({ index, event }) => index < CONSISTENCY_TIMELINE_LIMIT || pinned.has(event.id))
    overflow.push(...overflowOf('timeline', '时间线', CONSISTENCY_TIMELINE_LIMIT, indexed.filter(({ index, event }) => index >= CONSISTENCY_TIMELINE_LIMIT && !pinned.has(event.id))
      .map(({ event }) => ({ id: event.id, title: `时间线 · ${event.title || '未命名事件'}`, basis: ['时间线顺序'] }))))
    events.forEach(({ event, index }) => candidates.push({ id: event.id, kind: 'timeline', title: `时间线 · ${event.title || '未命名事件'}`,
      content: [`故事时间：${event.story_time_label || '未标注'}`, `顺序：第 ${index + 1} 个事件`, event.chapter_id ? `关联章节：${titles.get(event.chapter_id) ?? event.chapter_id}` : ''].filter(Boolean).join('；'),
      projectId, reason: '时间线事件（仅一致性检查使用）', priority: 76 - Math.min(5, index / 40),
      basis: pinned.has(event.id) ? [BASIS_LABELS.pinned, '时间线顺序'] : ['时间线顺序'] }))
    const excludedKinds = ['other_chapters', 'pending_memory', 'foreshadows', 'ideas', 'outlines', 'digests', 'story_notes', 'references', 'creative_chat', 'other_projects']
    // P2-2：先给设定/人物卡/时间线预留预算（本章至少保底 25%），剩余给本章；本章放不下则截断本章（保留开头）。
    const chapterFloor = Math.min(estimateTokens(chapter.plainText), Math.floor(budget * 0.25))
    // PR25 P2-3：设定/人物卡/时间线按类别轮转排列（各类内部仍按优先级），避免人物卡被大量设定挤掉。
    // P3-e：类内按 钉住 > 已确认 > 本章提及 > 最近更新 > id 排序（时间线保持故事顺序，仅钉住提前）；钉住的条目跨类别排在最前。
    const isPinned = (item: Candidate): boolean => pinned.has(item.id)
    const inKind = (a: Candidate, b: Candidate): number => a.rank && b.rank ? compareSettingRank(a.rank, b.rank) : Number(isPinned(b)) - Number(isPinned(a)) || b.priority - a.priority
    const sortedRefs = candidates.toSorted(inKind)
    const byKind = ['memory', 'character', 'timeline'].map((kind) => sortedRefs.filter((item) => item.kind === kind && !isPinned(item)))
    const rotated: Candidate[] = sortedRefs.filter(isPinned).map((item, index) => ({ ...item, priority: 95 - index / 1000 }))
    for (let round = 0; byKind.some((list) => round < list.length); round += 1)
      for (const list of byKind) if (round < list.length) rotated.push({ ...list[round], priority: 90 - rotated.length / 1000 })
    const refs = this.budget(projectId, 'consistency', rotated, Math.max(0, budget - chapterFloor), excludedKinds, task.excludedIds)
    const body = this.budget(projectId, 'consistency', [chapterItem], Math.max(0, budget - refs.metadata.estimatedTokens), excludedKinds, task.excludedIds)
    // 本章放在最后：runtime 若仍超预算，先截断本章而不是设定。
    const items = [...refs.items, ...body.items]
    return { projectId, policy: 'consistency', items, metadata: { estimatedTokens: refs.metadata.estimatedTokens + body.metadata.estimatedTokens,
      sourceIds: items.map((item) => item.id), excludedKinds, omitted: [...(body.metadata.omitted ?? []), ...(refs.metadata.omitted ?? [])], ...(overflow.length ? { overflow } : {}) } }
  }

  private buildCreative(task: AITaskEnvelope, budget: number): ContextBundle {
    const candidates: Candidate[] = []
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
    // P3-e：本章相关只看本章正文与当前选区（不含提问），纯本地字符串匹配
    const haystack = [task.selection?.text ?? '', currentText].join('\n')
    const pinned = new Set(task.includedIds ?? [])
    const statuses = ['confirmed', 'observed', 'tentative', 'idea'] as const
    // P3-e M1/M3：先取全部关键词相关记忆，按 钉住 > 状态权重 > 本章提及 > 关键词相关度（沿用 base 的 relevanceScore，含作者提问）> 更新 > id 排序，再截取 12 条
    const stateWeightOf = (status: string): number => status === 'confirmed' ? 85 : status === 'observed' ? 78 : status === 'tentative' ? 55 : 40
    const rankedRelevant = this.memories.searchRelevant(task.projectId, [...statuses], signal, Number.MAX_SAFE_INTEGER)
      .map((memory) => ({ memory, score: relevanceScore(memory.content, signal),
        rank: rankSetting({ id: memory.id, pinned: pinned.has(memory.id), confirmed: memory.status === 'confirmed', names: memoryEntryNames(memory.content), updatedAt: memory.updatedAt }, haystack) }))
      .toSorted((a, b) => Number(b.rank.pinned) - Number(a.rank.pinned) || stateWeightOf(b.memory.status) - stateWeightOf(a.memory.status)
        || Number(b.rank.mentioned) - Number(a.rank.mentioned) || b.score - a.score || compareSettingRank(a.rank, b.rank))
    const relevant = rankedRelevant.slice(0, CREATIVE_MEMORY_LIMIT).map((item) => item.memory)
    const overflow: ContextOverflow[] = overflowOf('memory', '记忆', CREATIVE_MEMORY_LIMIT, rankedRelevant.slice(CREATIVE_MEMORY_LIMIT).filter((item) => !item.rank.pinned)
      .map((item) => ({ id: item.memory.id, title: `记忆 · ${settingName(item.memory.content)}（${item.memory.type} · ${item.memory.status}）`, basis: settingBasis(item.rank) })))
    const pinnedMemories = this.memories.list(task.projectId, [...statuses]).filter((memory) => pinned.has(memory.id) && !relevant.some((item) => item.id === memory.id))
    for (const memory of [...relevant, ...pinnedMemories]) {
      const stateWeight = stateWeightOf(memory.status)
      const rank = rankSetting({ id: memory.id, pinned: pinned.has(memory.id), confirmed: memory.status === 'confirmed', names: memoryEntryNames(memory.content), updatedAt: memory.updatedAt }, haystack)
      candidates.push({ id: memory.id, kind: 'memory', title: `${memory.type} · ${memory.status}`, listTitle: `记忆 · ${settingName(memory.content)}（${memory.type} · ${memory.status}）`, content: memory.content,
        projectId: task.projectId, reason: rank.pinned && !relevant.includes(memory) ? `作者钉住的长期记忆，状态为 ${memory.status}` : `关键词相关的长期记忆，状态为 ${memory.status}`,
        priority: rank.pinned ? PINNED_PRIORITY : stateWeight, rank, basis: settingBasis(rank) })
    }

    overflow.push(...this.addCharacters(task.projectId, signal, candidates, haystack, pinned))
    this.addNotes(task.projectId, signal, task.mode, candidates)
    this.addOutlines(task.projectId, task.documentId, candidates)
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

    const bundle = this.budget(task.projectId, 'creative', candidates, budget, ['other_projects'], task.excludedIds, task.includedIds)
    return overflow.length ? { ...bundle, metadata: { ...bundle.metadata, overflow } } : bundle
  }

  private addCharacters(projectId: string, signal: string, candidates: Candidate[], haystack = '', pinned: Set<string> = new Set()): ContextOverflow[] {
    const rows = this.db.raw.prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Array<Record<string, unknown>>
    const ranked = rows.map((row) => ({
      character: { id: row.id as string, projectId, name: row.name as string, aliases: JSON.parse(row.aliases_json as string) as string[],
        notes: row.notes as string, fields: JSON.parse(row.fields_json as string) as Record<string, string>, createdAt: row.created_at as number, updatedAt: row.updated_at as number } satisfies Character,
      matched: [row.name as string, ...(JSON.parse(row.aliases_json as string) as string[])].some((name) => name && signal.includes(name))
    })).map((item) => ({ ...item, rank: rankSetting({ id: item.character.id, pinned: pinned.has(item.character.id), confirmed: false,
      names: [item.character.name, ...item.character.aliases], updatedAt: item.character.updatedAt }, haystack) }))
      // P3-e：钉住的人物卡即使未被提及也带上；8 条上限按确定排序截取
      .filter((item) => item.matched || item.rank.pinned).toSorted((a, b) => compareSettingRank(a.rank, b.rank))
    const split = withinLimitOrPinned(ranked, CREATIVE_CHARACTER_LIMIT, (item) => item.rank.pinned)
    split.kept.forEach(({ character, rank }) => candidates.push({
      id: character.id, kind: 'character', title: `人物 · ${character.name}`,
      content: [character.aliases.length ? `别名：${character.aliases.join('、')}` : '', character.notes, JSON.stringify(character.fields)].filter(Boolean).join('\n'),
      projectId, reason: rank.pinned ? '作者钉住的人物卡' : '问题、选区或当前章明确提及该人物', priority: rank.pinned ? PINNED_PRIORITY : 82, rank, basis: settingBasis(rank)
    }))
    return overflowOf('character', '人物卡', CREATIVE_CHARACTER_LIMIT, split.rest
      .map(({ character, rank }) => ({ id: character.id, title: `人物 · ${character.name}`, basis: settingBasis(rank) })))
  }

  private addNotes(projectId: string, signal: string, mode: AITaskEnvelope['mode'], candidates: Candidate[]): void {
    const rows = this.db.raw.prepare("SELECT * FROM project_notes WHERE project_id = ? AND section IN ('story','reference') ORDER BY updated_at DESC").all(projectId) as Array<Record<string, unknown>>
    rows.map((row) => ({ note: { id: row.id as string, projectId, section: row.section as ProjectNote['section'], title: row.title as string,
      content: row.content as string, createdAt: row.created_at as number, updatedAt: row.updated_at as number }, score: relevanceScore(`${row.title as string}\n${row.content as string}`, signal) }))
      .filter(({ note, score }) => score > 0 && (note.section === 'story' || /参考|资料|来源|背景/.test(signal) || mode === 'discussion'))
      .toSorted((a, b) => b.score - a.score).slice(0, 8).forEach(({ note, score }) => candidates.push({ id: note.id,
        kind: note.section === 'story' ? 'note' : 'reference', title: note.title, content: note.content, projectId,
        reason: note.section === 'story' ? '相关故事笔记' : '按需召回的相关参考资料', priority: 60 + score }))
  }

  /**
   * S5：细纲进 AI 上下文；优先级在选区之后、当前章之前（PRD §4）。
   * S6：清单可见可勾选，默认不发送（budget 里 default_excluded，除非 includedIds 勾选）。
   */
  private addOutlines(projectId: string, documentId: string | undefined, candidates: Candidate[]): void {
    const rows = this.db.raw.prepare(`SELECT o.node_id, o.summary, o.beats_json, o.hook, n.title, n.type
      FROM node_outlines o JOIN document_nodes n ON n.id = o.node_id
      WHERE o.project_id = ? AND n.project_id = ?`).all(projectId, projectId) as Array<Record<string, unknown>>
    for (const row of rows) {
      const beats = JSON.parse(String(row.beats_json ?? '[]')) as string[]
      const parts = [row.summary && `梗概：${row.summary}`, beats.length ? `节拍：${beats.join(' / ')}` : '', row.hook && `钩子：${row.hook}`].filter(Boolean)
      if (!parts.length) continue
      // 选区(100) > 本章细纲(98) > 卷梗概(97) > 当前章(95) > 他章细纲(94)
      const priority = row.node_id === documentId ? 98 : row.type === 'volume' ? 97 : 94
      candidates.push({
        id: `outline:${row.node_id}`, kind: 'outline', title: `大纲 · ${row.title}`, content: parts.join('\n'),
        projectId, reason: '卷/章细纲（默认不发送，勾选后带上；优先级在选区之后）', priority
      })
    }
    const notes = this.db.raw.prepare("SELECT * FROM project_notes WHERE project_id = ? AND section = 'outline' ORDER BY updated_at DESC")
      .all(projectId) as Array<Record<string, unknown>>
    for (const row of notes) {
      const content = String(row.content ?? '')
      if (!content.trim() && !String(row.title ?? '').trim()) continue
      candidates.push({
        id: `outline-note:${row.id}`, kind: 'outline', title: `大纲笔记 · ${row.title || '未命名'}`, content: content || String(row.title),
        projectId, reason: '全书核心大纲（默认不发送，勾选后带上；优先级在选区之后）', priority: 96
      })
    }
  }

  private addDigests(projectId: string, documentId: string | undefined, signal: string, candidates: Candidate[]): void {
    const ordered = this.documents.listOrderedChapters(projectId)
    const currentIndex = documentId ? ordered.findIndex((chapter) => chapter.id === documentId) : ordered.length
    const allowed = new Set(ordered.slice(0, currentIndex < 0 ? ordered.length : currentIndex).map((chapter) => chapter.id))
    const rows = this.db.raw.prepare('SELECT id, chapter_id, summary, created_at FROM chapter_digests WHERE project_id = ? AND stale = 0 ORDER BY created_at DESC')
      .all(projectId) as Array<{ id: string; chapter_id: string; summary: string; created_at: number }>
    rows.filter((row) => allowed.has(row.chapter_id)).map((row, index) => ({ row, score: relevanceScore(row.summary, signal), recent: index < 2 }))
      .filter((item) => item.score > 0 || item.recent).slice(0, 6).forEach(({ row, score }) => candidates.push({ id: row.id,
        kind: 'digest', title: '前文章节理解', content: row.summary, projectId, reason: '非陈旧的前章摘要', priority: 57 + score }))
  }

  /**
   * P1-5：读者上下文 = 仅第 1..N 章正文，按章树（卷序、章序）顺序；
   * 不带设定/记忆/细纲/大纲/时间线/伏笔/人物卡/第 N 章之后/他书内容。
   * 预算不足时按 S7 规则裁剪（保留靠近第 N 章的正文），被裁掉的章节进 omitted（reason=budget，清单显示「已省略」）。
   */
  buildReader(projectId: string, through: string | number, budget = 12_000, excludedIds: string[] = []): ContextBundle {
    const ordered = this.db.raw.prepare(`
      SELECT c.id, c.title, dc.plain_text
      FROM document_nodes c JOIN document_nodes v ON v.id = c.parent_id AND v.project_id = c.project_id
      JOIN document_contents dc ON dc.document_id = c.id AND dc.project_id = c.project_id
      WHERE c.project_id = ? AND c.type = 'chapter' AND v.type = 'volume'
      ORDER BY v.order_index, c.order_index, c.created_at
    `).all(projectId) as Array<{ id: string; title: string; plain_text: string }>
    let throughIndex: number
    if (typeof through === 'number') {
      const checked = validateReaderChapterNumber(through, ordered.length)
      if (!checked.ok) throw Object.assign(new Error(checked.error), { code: 'READER_CHAPTER_INVALID' })
      throughIndex = checked.index
    } else {
      throughIndex = ordered.findIndex((chapter) => chapter.id === through)
      if (throughIndex < 0) throw new Error('READER_CHAPTER_NOT_FOUND_IN_PROJECT')
    }
    const visible = ordered.slice(0, throughIndex + 1)
    const order = new Map(visible.map((chapter, index) => [chapter.id, index]))
    const candidates: Candidate[] = visible.map((chapter, index) => ({
      id: chapter.id, kind: 'document', title: `第 ${index + 1} 章 · ${chapter.title}`, content: chapter.plain_text, projectId,
      reason: `读者截至第 ${throughIndex + 1} 章可见的正文`, priority: 60 + index
    }))
    const bundle = this.budget(projectId, 'reader', candidates, budget, ['future_chapters', 'private_memory', 'creative_chat', 'ideas', 'future_plan', 'story_notes', 'references', 'digests', 'outlines', 'characters', 'timeline', 'foreshadows', 'other_projects'], excludedIds)
    const byOrder = (a: { id: string }, b: { id: string }): number => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    const items = bundle.items.toSorted(byOrder)
    return { ...bundle, items, metadata: { ...bundle.metadata, sourceIds: items.map((item) => item.id), omitted: (bundle.metadata.omitted ?? []).toSorted(byOrder) } }
  }

  private budget(projectId: string, policy: ContextBundle['policy'], candidates: Candidate[], maxTokens: number, excludedKinds: string[], excludedIds: string[] = [], includedIds: string[] = []): ContextBundle {
    // P3-e：同优先级的同类设定按确定规则排序（compareSettingRank），其余保持原插入顺序（稳定排序）
    const sorted = candidates.toSorted((a, b) => b.priority - a.priority || (a.rank && b.rank && a.kind === b.kind ? compareSettingRank(a.rank, b.rank) : 0))
    const excluded = new Set(excludedIds)
    const included = new Set(includedIds)
    const items: ContextItem[] = []
    const omitted: ContextOmission[] = []
    let estimatedTokens = 0
    const seen = new Set<string>()
    for (const { priority, rank, listTitle, ...item } of sorted) {
      void priority; void rank
      const basis = item.basis ? { basis: item.basis } : {}
      const key = `${item.kind}:${item.id}`
      if (seen.has(key) || item.projectId !== projectId) continue
      if (excluded.has(item.id)) { seen.add(key); omitted.push({ id: item.id, kind: item.kind, title: listTitle ?? item.title, reason: 'user_excluded', ...basis }); continue }
      // S6/P1：大纲进清单但默认不发送，除非 includedIds 勾选
      if (item.kind === 'outline' && !included.has(item.id)) {
        seen.add(key); omitted.push({ id: item.id, kind: item.kind, title: item.title, reason: 'default_excluded' }); continue
      }
      if (!item.content.trim()) continue
      const remaining = maxTokens - estimatedTokens
      if (remaining <= 0) { seen.add(key); omitted.push({ id: item.id, kind: item.kind, title: item.title, reason: 'budget', ...basis }); continue }
      const itemTokens = estimateTokens(item.content)
      const fitted = itemTokens <= remaining ? item : { ...item, content: truncateBySide(item.content, remaining * 2.2, truncationSideFor(policy)), truncated: true }
      const fittedTokens = estimateTokens(fitted.content)
      if (!fitted.content.trim()) continue
      items.push(fitted); seen.add(key); estimatedTokens += fittedTokens
    }
    return { projectId, policy, items, metadata: { estimatedTokens, sourceIds: items.map((item) => item.id), excludedKinds, omitted } }
  }
}
