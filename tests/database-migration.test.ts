import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database/database'

describe('database migrations', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

  it('adds patch document revision and invalidates legacy proposed patches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-migration-')); dirs.push(dir); const path = join(dir, 'old.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE text_patches(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document_id TEXT NOT NULL,block_id TEXT NOT NULL,from_pos INTEGER NOT NULL,to_pos INTEGER NOT NULL,original_hash TEXT NOT NULL,original_text TEXT NOT NULL,replacement TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
      INSERT INTO text_patches VALUES ('p','project','doc','plain-text',0,1,'hash','a','b','proposed',1);`)
    old.close()
    const db = new AppDatabase(path)
    const columns = db.raw.prepare('PRAGMA table_info(text_patches)').all() as Array<{ name: string }>
    expect(columns.some((column) => column.name === 'document_revision')).toBe(true)
    expect(db.raw.prepare('SELECT document_revision, status FROM text_patches WHERE id = ?').get('p')).toEqual({ document_revision: -1, status: 'stale' })
    db.close()
  })
})
