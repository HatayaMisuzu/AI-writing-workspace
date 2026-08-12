import { randomUUID } from 'node:crypto'
import type { Character, ProjectNote } from '../../shared/domain'
import type { AppDatabase } from '../database/database'

export class ProjectContentService {
  constructor(private readonly db: AppDatabase) {}

  listNotes(projectId: string, section: ProjectNote['section']): ProjectNote[] {
    const rows = this.db.raw.prepare('SELECT * FROM project_notes WHERE project_id = ? AND section = ? ORDER BY updated_at DESC').all(projectId, section) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: row.id as string, projectId: row.project_id as string, section: row.section as ProjectNote['section'],
      title: row.title as string, content: row.content as string, createdAt: row.created_at as number, updatedAt: row.updated_at as number }))
  }

  saveNote(input: { id?: string; projectId: string; section: ProjectNote['section']; title: string; content: string }): ProjectNote {
    const id = input.id ?? randomUUID(); const now = Date.now()
    this.db.raw.prepare(`INSERT INTO project_notes(id,project_id,section,title,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,updated_at=excluded.updated_at
      WHERE project_id=excluded.project_id AND section=excluded.section`)
      .run(id, input.projectId, input.section, input.title.trim() || '未命名笔记', input.content, now, now)
    const note = this.listNotes(input.projectId, input.section).find((item) => item.id === id)
    if (!note) throw new Error('NOTE_NOT_FOUND_IN_PROJECT')
    return note
  }

  deleteNote(projectId: string, noteId: string): void {
    const result = this.db.raw.prepare('DELETE FROM project_notes WHERE id = ? AND project_id = ?').run(noteId, projectId)
    if (result.changes !== 1) throw new Error('NOTE_NOT_FOUND_IN_PROJECT')
  }

  listCharacters(projectId: string): Character[] {
    const rows = this.db.raw.prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: row.id as string, projectId: row.project_id as string, name: row.name as string,
      aliases: JSON.parse(row.aliases_json as string) as string[], notes: row.notes as string,
      fields: JSON.parse(row.fields_json as string) as Record<string, string>, createdAt: row.created_at as number, updatedAt: row.updated_at as number }))
  }

  saveCharacter(input: { id?: string; projectId: string; name: string; aliases?: string[]; notes?: string; fields?: Record<string, string> }): Character {
    const id = input.id ?? randomUUID(); const now = Date.now()
    this.db.raw.prepare(`INSERT INTO characters(id,project_id,name,aliases_json,notes,fields_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,aliases_json=excluded.aliases_json,notes=excluded.notes,fields_json=excluded.fields_json,updated_at=excluded.updated_at
      WHERE project_id=excluded.project_id`)
      .run(id, input.projectId, input.name.trim() || '未命名人物', JSON.stringify(input.aliases ?? []), input.notes ?? '', JSON.stringify(input.fields ?? {}), now, now)
    const character = this.listCharacters(input.projectId).find((item) => item.id === id)
    if (!character) throw new Error('CHARACTER_NOT_FOUND_IN_PROJECT')
    return character
  }

  deleteCharacter(projectId: string, characterId: string): void {
    const result = this.db.raw.prepare('DELETE FROM characters WHERE id = ? AND project_id = ?').run(characterId, projectId)
    if (result.changes !== 1) throw new Error('CHARACTER_NOT_FOUND_IN_PROJECT')
  }
}
