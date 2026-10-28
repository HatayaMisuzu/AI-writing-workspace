import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import { Document, Packer, Paragraph, HeadingLevel } from 'docx'
import { z } from 'zod'
import type { Project } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { ProjectService } from './project-service'
import { DocumentService } from './document-service'

type SqlValue = string | number | bigint | Uint8Array | null
const sqlValue = (value: unknown): SqlValue => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (value instanceof Uint8Array) return value
  return JSON.stringify(value)
}

/** 解码导入的文本文件：识别 UTF-8/UTF-16 BOM，utf8 出现替换符时回退 GB18030（中文网文常见编码）。 */
const decodeTextFile = (buf: Buffer): string => {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try { return new TextDecoder('gb18030').decode(buf) } catch { return utf8 }
}

interface BackupPayload {
  format: 'inkstone-project'
  version: 1
  exportedAt: number
  project: Record<string, unknown>
  nodes: Array<Record<string, unknown>>
  contents: Array<Record<string, unknown>>
  snapshots: Array<Record<string, unknown>>
  ideas: Array<Record<string, unknown>>
  notes: Array<Record<string, unknown>>
  characters: Array<Record<string, unknown>>
  memories: Array<Record<string, unknown>>
  threads: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
  digests: Array<Record<string, unknown>>
  origins: Array<Record<string, unknown>>
  feedback: Array<Record<string, unknown>>
  styles?: Array<Record<string, unknown>>
  outlines?: Array<Record<string, unknown>>
  writingDaily?: Array<Record<string, unknown>>
  patches: Array<Record<string, unknown>>
}

const MAX_BACKUP_BYTES = 100 * 1024 * 1024
const rowSchema = z.record(z.string(), z.unknown()).refine((row) => typeof row.id === 'string' && row.id.length > 0, 'row id required')
const backupPayloadSchema = z.object({
  format: z.literal('inkstone-project'), version: z.literal(1), exportedAt: z.number().finite().nonnegative(),
  project: z.record(z.string(), z.unknown()).refine((row) => typeof row.id === 'string' && typeof row.title === 'string' &&
    ['novel','webnovel','screenplay','other'].includes(String(row.project_type)), 'invalid project'),
  nodes: z.array(rowSchema), contents: z.array(z.record(z.string(), z.unknown())), snapshots: z.array(rowSchema),
  ideas: z.array(rowSchema), notes: z.array(rowSchema), characters: z.array(rowSchema), memories: z.array(rowSchema),
  threads: z.array(rowSchema), messages: z.array(rowSchema), digests: z.array(rowSchema), origins: z.array(rowSchema),
  feedback: z.array(rowSchema), styles: z.array(rowSchema).optional(), patches: z.array(rowSchema),
  outlines: z.array(z.record(z.string(), z.unknown())).optional(),
  writingDaily: z.array(z.record(z.string(), z.unknown())).optional()
})

async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  const suffix = randomUUID()
  const temporary = join(dirname(path), `.${basename(path)}.${suffix}.tmp`)
  const previous = join(dirname(path), `.${basename(path)}.${suffix}.previous`)
  await writeFile(temporary, data, { flag: 'wx' })
  try {
    await rename(temporary, path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') { await unlink(temporary).catch(() => undefined); throw error }
    await rename(path, previous)
    try {
      await rename(temporary, path)
    } catch (replaceError) {
      await rename(previous, path).catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw replaceError
    }
    await unlink(previous).catch(() => undefined)
  }
}

/**
 * S1e：把节点排成"父节点在前"（按层级，同层保持 order_index 与原顺序），导入时逐行插入不会触发外键失败。
 * 兼容旧备份（乱序）；父节点缺失抛 BACKUP_INVALID_NODE_PARENT，存在环（含自指）抛 BACKUP_INVALID_NODE_CYCLE。
 */
export function orderNodesParentFirst<T extends Record<string, unknown>>(nodes: T[]): T[] {
  const ids = new Set(nodes.map((node) => node.id as string))
  const children = new Map<string | null, T[]>()
  for (const node of nodes) {
    const parent = (node.parent_id as string | null | undefined) || null
    if (parent !== null && !ids.has(parent)) throw new Error('BACKUP_INVALID_NODE_PARENT')
    children.set(parent, [...(children.get(parent) ?? []), node])
  }
  const byOrder = (a: T, b: T): number => Number(a.order_index ?? 0) - Number(b.order_index ?? 0)
  const ordered: T[] = []
  let level = [...(children.get(null) ?? [])].sort(byOrder)
  while (level.length) {
    ordered.push(...level)
    level = level.flatMap((node) => [...(children.get(node.id as string) ?? [])].sort(byOrder))
  }
  // 从根可达的节点都已输出；剩下的只能处在环上（或挂在环下）
  if (ordered.length !== nodes.length) throw new Error('BACKUP_INVALID_NODE_CYCLE')
  return ordered
}

function validateBackup(payload: BackupPayload): void {
  const assertEnum = (value: unknown, allowed: readonly string[], code: string): void => {
    if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(code)
  }
  const assertInteger = (value: unknown, minimum: number, code: string): void => {
    if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(code)
  }
  const groups = [payload.nodes, payload.snapshots, payload.ideas, payload.notes, payload.characters, payload.memories,
    payload.threads, payload.messages, payload.digests, payload.origins, payload.feedback, payload.styles ?? [], payload.patches]
  const allIds = new Set<string>()
  for (const group of groups) for (const row of group) {
    const id = row.id as string
    if (allIds.has(id)) throw new Error('BACKUP_INVALID_DUPLICATE_ID')
    allIds.add(id)
  }
  const projectId = payload.project.id as string
  for (const group of groups) for (const row of group) {
    if (row.project_id !== projectId) throw new Error('BACKUP_INVALID_CROSS_PROJECT_REFERENCE')
  }
  const nodeIds = new Set(payload.nodes.map((row) => row.id as string))
  const noteIds = new Set(payload.notes.map((row) => row.id as string))
  const messageIds = new Set(payload.messages.map((row) => row.id as string))
  const threadIds = new Set(payload.threads.map((row) => row.id as string))
  const digestIds = new Set(payload.digests.map((row) => row.id as string))
  const memoryIds = new Set(payload.memories.map((row) => row.id as string))
  payload.nodes.forEach((row) => {
    assertEnum(row.type, ['volume', 'chapter', 'scene', 'note'], 'BACKUP_INVALID_NODE_TYPE')
    assertInteger(row.order_index, 0, 'BACKUP_INVALID_NODE_ORDER')
    if (row.parent_id && !nodeIds.has(row.parent_id as string)) throw new Error('BACKUP_INVALID_NODE_PARENT')
  })
  const contentIds = new Set<string>()
  payload.contents.forEach((row) => {
    if (row.project_id !== projectId || !nodeIds.has(row.document_id as string)) throw new Error('BACKUP_INVALID_CONTENT_REFERENCE')
    if (contentIds.has(row.document_id as string)) throw new Error('BACKUP_INVALID_DUPLICATE_CONTENT')
    contentIds.add(row.document_id as string)
    if (typeof row.editor_json !== 'string' || typeof row.plain_text !== 'string') throw new Error('BACKUP_INVALID_CONTENT')
    assertInteger(row.revision, 0, 'BACKUP_INVALID_CONTENT')
    assertInteger(row.word_count, 0, 'BACKUP_INVALID_CONTENT')
    const editor = JSON.parse(row.editor_json) as { type?: unknown; content?: unknown }
    if (editor.type !== 'doc' || (editor.content !== undefined && !Array.isArray(editor.content))) throw new Error('BACKUP_INVALID_EDITOR_JSON')
  })
  payload.snapshots.forEach((row) => {
    if (!nodeIds.has(row.document_id as string)) throw new Error('BACKUP_INVALID_SNAPSHOT_REFERENCE')
    assertEnum(row.reason, ['interval', 'large_delete', 'ai_edit', 'manual', 'pre_restore'], 'BACKUP_INVALID_SNAPSHOT_REASON')
    assertInteger(row.revision, 0, 'BACKUP_INVALID_SNAPSHOT_REVISION')
  })
  payload.ideas.forEach((row) => assertEnum(row.status, ['active', 'used', 'archived'], 'BACKUP_INVALID_IDEA_STATUS'))
  payload.notes.forEach((row) => assertEnum(row.section, ['story', 'reference', 'outline'], 'BACKUP_INVALID_NOTE_SECTION'))
  payload.characters.forEach((row) => {
    if (!Array.isArray(JSON.parse(String(row.aliases_json))) || typeof JSON.parse(String(row.fields_json)) !== 'object') throw new Error('BACKUP_INVALID_CHARACTER_JSON')
  })
  payload.messages.forEach((row) => {
    if (!threadIds.has(row.thread_id as string)) throw new Error('BACKUP_INVALID_MESSAGE_THREAD')
    assertEnum(row.role, ['user', 'assistant'], 'BACKUP_INVALID_MESSAGE_ROLE')
    assertEnum(row.task_mode, ['discussion', 'brainstorm', 'generation', 'editing', 'organization', 'chapter_digest', 'proofreading', 'reader_review'], 'BACKUP_INVALID_MESSAGE_MODE')
    assertEnum(row.status, ['streaming', 'complete', 'error', 'cancelled'], 'BACKUP_INVALID_MESSAGE_STATUS')
  })
  payload.digests.forEach((row) => {
    if (!nodeIds.has(row.chapter_id as string)) throw new Error('BACKUP_INVALID_DIGEST_CHAPTER')
    assertInteger(row.chapter_revision, 0, 'BACKUP_INVALID_DIGEST_REVISION')
  })
  payload.memories.forEach((row) => {
    assertEnum(row.type, ['fact', 'event', 'character_state', 'relationship', 'decision', 'idea', 'question', 'foreshadowing', 'style_signal'], 'BACKUP_INVALID_MEMORY_TYPE')
    assertEnum(row.status, ['observed', 'confirmed', 'tentative', 'idea', 'suggested', 'rejected', 'superseded'], 'BACKUP_INVALID_MEMORY_STATUS')
    assertEnum(row.source_type, ['chapter', 'note', 'chat', 'author'], 'BACKUP_INVALID_MEMORY_SOURCE')
    if (row.supersedes && (!memoryIds.has(row.supersedes as string) || row.supersedes === row.id)) throw new Error('BACKUP_INVALID_MEMORY_REFERENCE')
    if (row.source_digest_id && !digestIds.has(row.source_digest_id as string)) throw new Error('BACKUP_INVALID_MEMORY_DIGEST')
    if (row.source_type === 'chapter' && !nodeIds.has(row.source_id as string)) throw new Error('BACKUP_INVALID_MEMORY_SOURCE')
    if (row.source_type === 'note' && !noteIds.has(row.source_id as string)) throw new Error('BACKUP_INVALID_MEMORY_SOURCE')
    if (row.source_type === 'chat' && !messageIds.has(row.source_id as string)) throw new Error('BACKUP_INVALID_MEMORY_SOURCE')
    if (row.confidence !== null && row.confidence !== undefined && (!Number.isFinite(row.confidence) || (row.confidence as number) < 0 || (row.confidence as number) > 1)) throw new Error('BACKUP_INVALID_MEMORY_CONFIDENCE')
  })
  payload.origins.forEach((row) => {
    if (!nodeIds.has(row.document_id as string)) throw new Error('BACKUP_INVALID_ORIGIN_DOCUMENT')
    assertEnum(row.origin, ['human', 'ai', 'ai_edited_by_human', 'mixed'], 'BACKUP_INVALID_TEXT_ORIGIN')
    assertInteger(row.from_pos, 0, 'BACKUP_INVALID_TEXT_RANGE'); assertInteger(row.to_pos, row.from_pos as number, 'BACKUP_INVALID_TEXT_RANGE')
  })
  ;(payload.styles ?? []).forEach((row) => {
    if (row.document_id && !nodeIds.has(row.document_id as string)) throw new Error('BACKUP_INVALID_STYLE_DOCUMENT')
    assertEnum(row.origin, ['human', 'ai', 'ai_edited_by_human', 'mixed'], 'BACKUP_INVALID_TEXT_ORIGIN')
  })
  const outlineNodeIds = new Set<string>()
  ;(payload.outlines ?? []).forEach((row) => {
    if (row.project_id !== projectId || !nodeIds.has(row.node_id as string)) throw new Error('BACKUP_INVALID_OUTLINE_REFERENCE')
    if (outlineNodeIds.has(row.node_id as string)) throw new Error('BACKUP_INVALID_DUPLICATE_OUTLINE')
    outlineNodeIds.add(row.node_id as string)
    const node = payload.nodes.find((item) => item.id === row.node_id)
    assertEnum(node?.type, ['volume', 'chapter'], 'BACKUP_INVALID_OUTLINE_NODE_TYPE')
    if (typeof row.summary !== 'string' || typeof row.hook !== 'string') throw new Error('BACKUP_INVALID_OUTLINE')
    const beats = JSON.parse(String(row.beats_json)) as unknown
    if (!Array.isArray(beats) || !beats.every((beat) => typeof beat === 'string')) throw new Error('BACKUP_INVALID_OUTLINE')
  })
  ;(payload.writingDaily ?? []).forEach((row) => {
    if (row.project_id !== projectId) throw new Error('BACKUP_INVALID_WRITING_DAILY')
    if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error('BACKUP_INVALID_WRITING_DAILY_DATE')
    for (const key of ['human_words_added', 'human_words_deleted', 'ai_words_accepted', 'active_seconds'] as const) {
      const n = row[key]
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new Error('BACKUP_INVALID_WRITING_DAILY')
    }
  })
  payload.patches.forEach((row) => {
    if (!nodeIds.has(row.document_id as string)) throw new Error('BACKUP_INVALID_PATCH_DOCUMENT')
    assertEnum(row.status, ['proposed', 'accepted', 'rejected', 'stale'], 'BACKUP_INVALID_PATCH_STATUS')
    assertInteger(row.from_pos, 0, 'BACKUP_INVALID_PATCH_RANGE'); assertInteger(row.to_pos, row.from_pos as number, 'BACKUP_INVALID_PATCH_RANGE')
  })
  payload.nodes = orderNodesParentFirst(payload.nodes)
  for (const memory of payload.memories) {
    const visited = new Set<string>([memory.id as string])
    let cursor = memory.supersedes as string | undefined
    while (cursor) {
      if (visited.has(cursor)) throw new Error('BACKUP_INVALID_MEMORY_CYCLE')
      visited.add(cursor)
      cursor = payload.memories.find((row) => row.id === cursor)?.supersedes as string | undefined
    }
  }
}

const rows = (db: AppDatabase, table: string, projectId: string): Array<Record<string, unknown>> =>
  db.raw.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(projectId) as Array<Record<string, unknown>>

export class BackupService {
  constructor(private readonly db: AppDatabase) {}

  async exportProject(projectId: string, path: string): Promise<void> {
    const project = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined
    if (!project) throw new Error('PROJECT_NOT_FOUND')
    const payload: BackupPayload = {
      format: 'inkstone-project', version: 1, exportedAt: Date.now(), project,
      nodes: orderNodesParentFirst(rows(this.db, 'document_nodes', projectId)), contents: rows(this.db, 'document_contents', projectId),
      snapshots: rows(this.db, 'snapshots', projectId), ideas: rows(this.db, 'ideas', projectId), notes: rows(this.db, 'project_notes', projectId),
      characters: rows(this.db, 'characters', projectId), memories: rows(this.db, 'memories', projectId),
      threads: rows(this.db, 'chat_threads', projectId), messages: rows(this.db, 'chat_messages', projectId),
      digests: rows(this.db, 'chapter_digests', projectId), origins: rows(this.db, 'text_origins', projectId),
      feedback: rows(this.db, 'style_feedback', projectId), styles: rows(this.db, 'style_samples', projectId),
      patches: rows(this.db, 'text_patches', projectId), outlines: rows(this.db, 'node_outlines', projectId),
      writingDaily: rows(this.db, 'writing_daily', projectId)
    }
    await atomicWriteFile(path, JSON.stringify(payload, (_key, value) => Buffer.isBuffer(value) ? value.toString('base64') : value, 2))
  }

  async importProject(path: string): Promise<Project> {
    const bytes = await readFile(path)
    if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error('BACKUP_INVALID_TOO_LARGE')
    let payload: BackupPayload
    try {
      payload = backupPayloadSchema.parse(JSON.parse(bytes.toString('utf8'))) as BackupPayload
      validateBackup(payload)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('BACKUP_INVALID_')) throw error
      throw Object.assign(new Error('BACKUP_INVALID_SCHEMA'), { cause: error })
    }
    const projectId = randomUUID()
    const idMap = new Map<string, string>()
    payload.nodes.forEach((node) => idMap.set(node.id as string, randomUUID()))
    payload.ideas.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.notes?.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.characters.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.memories.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.threads.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.snapshots.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.messages.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.digests.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.origins.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.feedback.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.styles?.forEach((item) => idMap.set(item.id as string, randomUUID()))
    payload.patches.forEach((item) => idMap.set(item.id as string, randomUUID()))
    const now = Date.now()
    this.db.transaction(() => {
      this.db.raw.prepare(`INSERT INTO projects(id,title,project_type,description,cover_seed,settings_json,archived,created_at,updated_at,last_opened_at)
        VALUES (?,?,?,?,?,?,0,?,?,?)`).run(...[projectId, `${payload.project.title as string}（已导入）`, payload.project.project_type,
        payload.project.description ?? '', projectId.slice(0, 8), payload.project.settings_json ?? '{}', now, now, now].map(sqlValue))
      const nodeInsert = this.db.raw.prepare(`INSERT INTO document_nodes(id,project_id,parent_id,type,title,order_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      payload.nodes.forEach((node) => nodeInsert.run(...[idMap.get(node.id as string), projectId,
        node.parent_id ? idMap.get(node.parent_id as string) : null, node.type, node.title, node.order_index, now, now].map(sqlValue)))
      const contentInsert = this.db.raw.prepare(`INSERT INTO document_contents(document_id,project_id,editor_json,plain_text,word_count,revision,updated_at) VALUES (?,?,?,?,?,?,?)`)
      const ftsInsert = this.db.raw.prepare('INSERT INTO document_fts(project_id,document_id,title,plain_text) VALUES (?,?,?,?)')
      payload.contents.forEach((content) => {
        const newDocumentId = idMap.get(content.document_id as string)
        if (!newDocumentId) return
        contentInsert.run(...[newDocumentId, projectId, content.editor_json, content.plain_text, content.word_count, content.revision, now].map(sqlValue))
        const node = payload.nodes.find((item) => item.id === content.document_id)
        ftsInsert.run(...[projectId, newDocumentId, node?.title ?? '未命名', content.plain_text].map(sqlValue))
      })
      const outlineInsert = this.db.raw.prepare(`INSERT INTO node_outlines(node_id,project_id,summary,beats_json,hook,updated_at) VALUES (?,?,?,?,?,?)`)
      payload.outlines?.forEach((item) => outlineInsert.run(...[idMap.get(item.node_id as string), projectId, item.summary, item.beats_json, item.hook, item.updated_at ?? now].map(sqlValue)))
      const writingInsert = this.db.raw.prepare(`INSERT INTO writing_daily(project_id,date,human_words_added,human_words_deleted,ai_words_accepted,active_seconds) VALUES (?,?,?,?,?,?)`)
      payload.writingDaily?.forEach((item) => writingInsert.run(...[projectId, item.date, item.human_words_added ?? 0, item.human_words_deleted ?? 0, item.ai_words_accepted ?? 0, item.active_seconds ?? 0].map(sqlValue)))
      const ideaInsert = this.db.raw.prepare(`INSERT INTO ideas(id,project_id,content,status,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      payload.ideas.forEach((idea) => ideaInsert.run(...[idMap.get(idea.id as string), projectId, idea.content, idea.status, idea.tags_json, now, now].map(sqlValue)))
      const noteInsert = this.db.raw.prepare(`INSERT INTO project_notes(id,project_id,section,title,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      payload.notes?.forEach((item) => noteInsert.run(...[idMap.get(item.id as string), projectId, item.section, item.title, item.content, item.created_at, item.updated_at].map(sqlValue)))
      const characterInsert = this.db.raw.prepare(`INSERT INTO characters(id,project_id,name,aliases_json,notes,fields_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      payload.characters.forEach((item) => characterInsert.run(...[idMap.get(item.id as string), projectId, item.name, item.aliases_json, item.notes, item.fields_json, now, now].map(sqlValue)))
      const memoryInsert = this.db.raw.prepare(`INSERT INTO memories(id,project_id,type,content,status,source_type,source_id,source_location,confidence,reader_visible_from,supersedes,source_revision,source_digest_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,?,?)`)
      payload.memories.forEach((item) => memoryInsert.run(...[idMap.get(item.id as string), projectId, item.type, item.content, item.status,
        item.source_type, idMap.get(item.source_id as string) ?? item.source_id, item.source_location, item.confidence,
        item.reader_visible_from, item.source_revision, now, now].map(sqlValue)))
      const snapshotInsert = this.db.raw.prepare(`INSERT INTO snapshots(id,project_id,document_id,reason,revision,content,plain_text,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      payload.snapshots.forEach((item) => snapshotInsert.run(...[idMap.get(item.id as string), projectId, idMap.get(item.document_id as string), item.reason, item.revision, item.content, item.plain_text, item.metadata_json, item.created_at].map(sqlValue)))
      const threadInsert = this.db.raw.prepare(`INSERT INTO chat_threads(id,project_id,title,summary,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      payload.threads.forEach((item) => threadInsert.run(...[idMap.get(item.id as string), projectId, item.title, item.summary, item.created_at, item.updated_at].map(sqlValue)))
      const messageInsert = this.db.raw.prepare(`INSERT INTO chat_messages(id,thread_id,project_id,role,content,task_mode,context_snapshot_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      payload.messages.forEach((item) => messageInsert.run(...[idMap.get(item.id as string), idMap.get(item.thread_id as string), projectId, item.role, item.content, item.task_mode, item.context_snapshot_json, item.status, item.created_at].map(sqlValue)))
      const digestInsert = this.db.raw.prepare(`INSERT INTO chapter_digests(id,project_id,chapter_id,chapter_revision,summary,structured_payload,stale,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      payload.digests.forEach((item) => digestInsert.run(...[idMap.get(item.id as string), projectId, idMap.get(item.chapter_id as string), item.chapter_revision, item.summary, item.structured_payload, item.stale, item.created_at].map(sqlValue)))
      const memoryLinks = this.db.raw.prepare('UPDATE memories SET supersedes = ?, source_digest_id = ? WHERE id = ? AND project_id = ?')
      payload.memories.forEach((item) => memoryLinks.run(
        item.supersedes ? idMap.get(item.supersedes as string)! : null,
        item.source_digest_id ? idMap.get(item.source_digest_id as string)! : null,
        idMap.get(item.id as string)!, projectId))
      const originInsert = this.db.raw.prepare(`INSERT INTO text_origins(id,project_id,document_id,from_pos,to_pos,origin,created_at) VALUES (?,?,?,?,?,?,?)`)
      payload.origins.forEach((item) => originInsert.run(...[idMap.get(item.id as string), projectId, idMap.get(item.document_id as string), item.from_pos, item.to_pos, item.origin, item.created_at].map(sqlValue)))
      const feedbackInsert = this.db.raw.prepare(`INSERT INTO style_feedback(id,project_id,text_sample,feedback_type,comment,created_at) VALUES (?,?,?,?,?,?)`)
      payload.feedback.forEach((item) => feedbackInsert.run(...[idMap.get(item.id as string), projectId, item.text_sample, item.feedback_type, item.comment, item.created_at].map(sqlValue)))
      const styleInsert = this.db.raw.prepare(`INSERT INTO style_samples(id,project_id,document_id,origin,text,text_hash,source_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      payload.styles?.forEach((item) => styleInsert.run(...[idMap.get(item.id as string), projectId,
        item.document_id ? idMap.get(item.document_id as string) : null, item.origin, item.text, item.text_hash,
        item.source_revision, item.created_at, item.updated_at].map(sqlValue)))
      const patchInsert = this.db.raw.prepare(`INSERT INTO text_patches(id,project_id,document_id,block_id,document_revision,from_pos,to_pos,original_hash,original_text,replacement,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      payload.patches.forEach((item) => patchInsert.run(...[idMap.get(item.id as string), projectId, idMap.get(item.document_id as string), item.block_id ?? 'pm-range', item.document_revision ?? -1, item.from_pos, item.to_pos, item.original_hash, item.original_text, item.replacement, item.document_revision === undefined && item.status === 'proposed' ? 'stale' : item.status, item.created_at].map(sqlValue)))
    })
    return new ProjectService(this.db).get(projectId)
  }

  async importManuscript(path: string): Promise<Project> {
    const source = decodeTextFile(await readFile(path))
    const extension = extname(path).toLowerCase()
    if (!['.txt', '.md', '.markdown'].includes(extension)) throw new Error('UNSUPPORTED_MANUSCRIPT')

    const title = basename(path, extension).trim() || '导入作品'
    const projects = new ProjectService(this.db)
    const documents = new DocumentService(this.db)
    const project = projects.create({ title, projectType: 'other', description: `从 ${basename(path)} 导入` })
    const defaultVolume = documents.listTree(project.id).find((node) => node.type === 'volume')
    if (defaultVolume) documents.delete(project.id, defaultVolume.id)

    const volumes = extension === '.txt'
      ? [{ title: '正文', chapters: [{ title: '正文', body: source.trim() }] }]
      : this.parseMarkdown(source)

    for (const volumeData of volumes) {
      const volume = documents.createNode({ projectId: project.id, type: 'volume', title: volumeData.title })
      for (const chapterData of volumeData.chapters) {
        const chapter = documents.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: chapterData.title })
        documents.saveContent({
          projectId: project.id,
          documentId: chapter.id,
          editorJson: this.toEditorJson(chapterData.body),
          plainText: chapterData.body
        })
      }
    }
    return projects.get(project.id)
  }

  private parseMarkdown(source: string): Array<{ title: string; chapters: Array<{ title: string; body: string }> }> {
    const volumes: Array<{ title: string; chapters: Array<{ title: string; body: string }> }> = []
    let volume = { title: '正文', chapters: [] as Array<{ title: string; body: string }> }
    let chapter = { title: '正文', body: '' }
    let hasChapter = false

    const commitChapter = (): void => {
      if (hasChapter || chapter.body.trim()) volume.chapters.push({ title: chapter.title, body: chapter.body.trim() })
      chapter = { title: '正文', body: '' }
      hasChapter = false
    }
    const commitVolume = (): void => {
      commitChapter()
      if (volume.chapters.length > 0) volumes.push(volume)
    }

    for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
      const volumeHeading = line.match(/^#\s+(.+?)\s*$/)
      const chapterHeading = line.match(/^##\s+(.+?)\s*$/)
      if (chapterHeading) {
        commitChapter()
        chapter = { title: chapterHeading[1], body: '' }
        hasChapter = true
      } else if (volumeHeading) {
        commitVolume()
        volume = { title: volumeHeading[1], chapters: [] }
      } else {
        chapter.body += `${chapter.body ? '\n' : ''}${line}`
      }
    }
    commitVolume()
    if (volumes.length === 0) return [{ title: '正文', chapters: [{ title: '正文', body: source.trim() }] }]
    return volumes
  }

  private toEditorJson(text: string): Record<string, unknown> {
    const paragraphs = (text || '').split(/\n{2,}/).map((value) => value.trim()).filter(Boolean)
    return {
      type: 'doc',
      content: (paragraphs.length ? paragraphs : ['']).map((value) => ({
        type: 'paragraph',
        ...(value ? { content: [{ type: 'text', text: value }] } : {})
      }))
    }
  }

  async exportManuscript(projectId: string, path: string, format: 'txt' | 'md' | 'docx'): Promise<void> {
    const chapters = this.db.raw.prepare(`
      SELECT COALESCE(v.title, '') AS volume_title, c.title, dc.plain_text
      FROM document_nodes c
      LEFT JOIN document_nodes v
        ON v.id = c.parent_id AND v.project_id = c.project_id AND v.type = 'volume'
      LEFT JOIN document_contents dc
        ON dc.document_id = c.id AND dc.project_id = c.project_id
      WHERE c.project_id = ? AND c.type = 'chapter'
      ORDER BY COALESCE(v.order_index, 2147483647), c.order_index, c.created_at
    `).all(projectId) as Array<{ volume_title: string; title: string; plain_text: string | null }>
    const MISSING_PLACEHOLDER = '［本章内容缺失：导出时正文数据不完整，请检查应用数据］'
    if (format === 'docx') {
      const children: Paragraph[] = []
      let currentVolume = ''
      chapters.forEach((chapter) => {
        if (chapter.volume_title !== currentVolume) {
          currentVolume = chapter.volume_title
          children.push(new Paragraph({ text: currentVolume, heading: HeadingLevel.HEADING_1 }))
        }
        children.push(new Paragraph({ text: chapter.title, heading: HeadingLevel.HEADING_2 }))
        ;(chapter.plain_text ?? MISSING_PLACEHOLDER).split(/\n+/).forEach((text) => children.push(new Paragraph({ text })))
      })
      const doc = new Document({ sections: [{ children }] })
      await atomicWriteFile(path, await Packer.toBuffer(doc))
      return
    }
    let currentVolume = ''
    const parts: string[] = []
    chapters.forEach((chapter) => {
      if (chapter.volume_title !== currentVolume) {
        currentVolume = chapter.volume_title
        parts.push(format === 'md' ? `# ${currentVolume}` : currentVolume)
      }
      const body = chapter.plain_text !== null ? chapter.plain_text : MISSING_PLACEHOLDER
      parts.push(format === 'md' ? `## ${chapter.title}\n\n${body}` : `${chapter.title}\n\n${body}`)
    })
    await atomicWriteFile(path, parts.join('\n\n'))
  }
}
