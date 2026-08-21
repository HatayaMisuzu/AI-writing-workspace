import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { Document, Packer, Paragraph, HeadingLevel } from 'docx'
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
  patches: Array<Record<string, unknown>>
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
      nodes: rows(this.db, 'document_nodes', projectId), contents: rows(this.db, 'document_contents', projectId),
      snapshots: rows(this.db, 'snapshots', projectId), ideas: rows(this.db, 'ideas', projectId), notes: rows(this.db, 'project_notes', projectId),
      characters: rows(this.db, 'characters', projectId), memories: rows(this.db, 'memories', projectId),
      threads: rows(this.db, 'chat_threads', projectId), messages: rows(this.db, 'chat_messages', projectId),
      digests: rows(this.db, 'chapter_digests', projectId), origins: rows(this.db, 'text_origins', projectId),
      feedback: rows(this.db, 'style_feedback', projectId), styles: rows(this.db, 'style_samples', projectId),
      patches: rows(this.db, 'text_patches', projectId)
    }
    await writeFile(path, JSON.stringify(payload, (_key, value) => Buffer.isBuffer(value) ? value.toString('base64') : value, 2), 'utf8')
  }

  async importProject(path: string): Promise<Project> {
    const payload = JSON.parse(await readFile(path, 'utf8')) as BackupPayload
    if (payload.format !== 'inkstone-project' || payload.version !== 1) throw new Error('UNSUPPORTED_BACKUP')
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
      const ideaInsert = this.db.raw.prepare(`INSERT INTO ideas(id,project_id,content,status,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      payload.ideas.forEach((idea) => ideaInsert.run(...[idMap.get(idea.id as string), projectId, idea.content, idea.status, idea.tags_json, now, now].map(sqlValue)))
      const noteInsert = this.db.raw.prepare(`INSERT INTO project_notes(id,project_id,section,title,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      payload.notes?.forEach((item) => noteInsert.run(...[idMap.get(item.id as string), projectId, item.section, item.title, item.content, item.created_at, item.updated_at].map(sqlValue)))
      const characterInsert = this.db.raw.prepare(`INSERT INTO characters(id,project_id,name,aliases_json,notes,fields_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      payload.characters.forEach((item) => characterInsert.run(...[idMap.get(item.id as string), projectId, item.name, item.aliases_json, item.notes, item.fields_json, now, now].map(sqlValue)))
      const memoryInsert = this.db.raw.prepare(`INSERT INTO memories(id,project_id,type,content,status,source_type,source_id,source_location,confidence,reader_visible_from,supersedes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      payload.memories.forEach((item) => memoryInsert.run(...[idMap.get(item.id as string), projectId, item.type, item.content, item.status,
        item.source_type, idMap.get(item.source_id as string) ?? item.source_id, item.source_location, item.confidence,
        item.reader_visible_from, item.supersedes ? idMap.get(item.supersedes as string) : null, now, now].map(sqlValue)))
      const snapshotInsert = this.db.raw.prepare(`INSERT INTO snapshots(id,project_id,document_id,reason,revision,content,plain_text,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      payload.snapshots.forEach((item) => snapshotInsert.run(...[idMap.get(item.id as string), projectId, idMap.get(item.document_id as string), item.reason, item.revision, item.content, item.plain_text, item.metadata_json, item.created_at].map(sqlValue)))
      const threadInsert = this.db.raw.prepare(`INSERT INTO chat_threads(id,project_id,title,summary,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      payload.threads.forEach((item) => threadInsert.run(...[idMap.get(item.id as string), projectId, item.title, item.summary, item.created_at, item.updated_at].map(sqlValue)))
      const messageInsert = this.db.raw.prepare(`INSERT INTO chat_messages(id,thread_id,project_id,role,content,task_mode,context_snapshot_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      payload.messages.forEach((item) => messageInsert.run(...[idMap.get(item.id as string), idMap.get(item.thread_id as string), projectId, item.role, item.content, item.task_mode, item.context_snapshot_json, item.status, item.created_at].map(sqlValue)))
      const digestInsert = this.db.raw.prepare(`INSERT INTO chapter_digests(id,project_id,chapter_id,chapter_revision,summary,structured_payload,stale,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      payload.digests.forEach((item) => digestInsert.run(...[idMap.get(item.id as string), projectId, idMap.get(item.chapter_id as string), item.chapter_revision, item.summary, item.structured_payload, item.stale, item.created_at].map(sqlValue)))
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
      await writeFile(path, await Packer.toBuffer(doc))
      return
    }
    let currentVolume = ''
    const parts: string[] = []
    chapters.forEach((chapter) => {
      if (chapter.volume_title !== currentVolume) {
        currentVolume = chapter.volume_title
        parts.push(format === 'md' ? `# ${currentVolume}` : currentVolume)
      }
      const body = chapter.plain_text !== null && chapter.plain_text !== '' ? chapter.plain_text : MISSING_PLACEHOLDER
      parts.push(format === 'md' ? `## ${chapter.title}\n\n${body}` : `${chapter.title}\n\n${body}`)
    })
    await writeFile(path, parts.join('\n\n'), 'utf8')
  }
}
