import { randomUUID } from 'node:crypto'
import type { Project, ProjectType } from '../../shared/domain'
import type { AppDatabase } from '../database/database'

type ProjectRow = {
  id: string; title: string; project_type: ProjectType; description: string; cover_seed: string
  archived: number; created_at: number; updated_at: number; last_opened_at: number; total_word_count: number
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    projectType: row.project_type,
    description: row.description,
    coverSeed: row.cover_seed,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    totalWordCount: row.total_word_count ?? 0
  }
}

export class ProjectService {
  constructor(private readonly db: AppDatabase) {}

  list(includeArchived = false): Project[] {
    const rows = this.db.raw.prepare(`
      SELECT p.*, COALESCE(SUM(c.word_count), 0) AS total_word_count
      FROM projects p LEFT JOIN document_contents c ON c.project_id = p.id
      WHERE (? = 1 OR p.archived = 0)
      GROUP BY p.id ORDER BY p.last_opened_at DESC, p.updated_at DESC
    `).all(includeArchived ? 1 : 0) as ProjectRow[]
    return rows.map(mapProject)
  }

  get(projectId: string): Project {
    const row = this.db.raw.prepare(`
      SELECT p.*, COALESCE(SUM(c.word_count), 0) AS total_word_count
      FROM projects p LEFT JOIN document_contents c ON c.project_id = p.id
      WHERE p.id = ? GROUP BY p.id
    `).get(projectId) as ProjectRow | undefined
    if (!row) throw new Error('PROJECT_NOT_FOUND')
    return mapProject(row)
  }

  create(input: { title: string; projectType: ProjectType; description?: string }): Project {
    const now = Date.now()
    const projectId = randomUUID()
    const volumeId = randomUUID()
    const chapterId = randomUUID()
    const title = input.title.trim() || '未命名作品'
    this.db.transaction(() => {
      this.db.raw.prepare(`INSERT INTO projects
        (id, title, project_type, description, cover_seed, created_at, updated_at, last_opened_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectId, title, input.projectType, input.description ?? '', projectId.slice(0, 8), now, now, now)
      this.db.raw.prepare(`INSERT INTO document_nodes
        (id, project_id, parent_id, type, title, order_index, created_at, updated_at)
        VALUES (?, ?, NULL, 'volume', '第一卷', 0, ?, ?)`)
        .run(volumeId, projectId, now, now)
      this.db.raw.prepare(`INSERT INTO document_nodes
        (id, project_id, parent_id, type, title, order_index, created_at, updated_at)
        VALUES (?, ?, ?, 'chapter', '第一章', 0, ?, ?)`)
        .run(chapterId, projectId, volumeId, now, now)
      const empty = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
      this.db.raw.prepare(`INSERT INTO document_contents
        (document_id, project_id, editor_json, plain_text, word_count, revision, updated_at)
        VALUES (?, ?, ?, '', 0, 0, ?)`)
        .run(chapterId, projectId, empty, now)
      this.db.raw.prepare('INSERT INTO document_fts(project_id, document_id, title, plain_text) VALUES (?, ?, ?, ?)')
        .run(projectId, chapterId, '第一章', '')
    })
    return this.get(projectId)
  }

  touch(projectId: string): void {
    const result = this.db.raw.prepare('UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), projectId)
    if (result.changes !== 1) throw new Error('PROJECT_NOT_FOUND')
  }

  rename(projectId: string, title: string): Project {
    const result = this.db.raw.prepare('UPDATE projects SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.trim(), Date.now(), projectId)
    if (result.changes !== 1) throw new Error('PROJECT_NOT_FOUND')
    return this.get(projectId)
  }

  archive(projectId: string, archived: boolean): void {
    const result = this.db.raw.prepare('UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, Date.now(), projectId)
    if (result.changes !== 1) throw new Error('PROJECT_NOT_FOUND')
  }

  deletePermanently(projectId: string): void {
    this.db.transaction(() => {
      this.db.raw.prepare('DELETE FROM document_fts WHERE project_id = ?').run(projectId)
      const result = this.db.raw.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
      if (result.changes !== 1) throw new Error('PROJECT_NOT_FOUND')
    })
  }
}
