import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ChatService } from '../src/main/services/chat-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ProviderService } from '../src/main/ai/provider'
import { testCodec } from './helpers'

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

  it('preserves v0.2 project, document and chat data while completing interrupted messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-v02-migration-')); dirs.push(dir); const path = join(dir, 'v02.sqlite')
    const first = new AppDatabase(path); const project = new ProjectService(first).create({ title: '旧版长篇', projectType: 'novel' })
    const docs = new DocumentService(first); const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '迁移前的正文不会丢失。' })
    const chat = new ChatService(first); const thread = chat.createThread(project.id, '旧对话')
    chat.startTurn({ projectId: project.id, threadId: thread.id, userMessageId: 'old-u', assistantMessageId: 'old-a', content: '迁移问题', mode: 'discussion' })
    const oldMemory = new MemoryService(first).create({ projectId: project.id, type: 'fact', content: '旧记忆仍存在', status: 'suggested', sourceType: 'author', sourceId: 'legacy' })
    new MemoryService(first).confirm(project.id, oldMemory.id, 'user')
    const oldProviders = new ProviderService(first, testCodec)
    oldProviders.save({ id: 'old-provider', providerType: 'openai-compatible', displayName: '旧服务', baseUrl: 'http://old.local/v1', apiKey: 'old-key' })
    oldProviders.saveModel({ id: 'old-model', providerId: 'old-provider', modelId: 'old-model-id', displayName: '旧模型', enabled: true, isDefault: true, capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    oldProviders.setRoute('proofreading', 'old-model')
    first.raw.prepare("UPDATE app_settings SET value_json = '2' WHERE key = 'schema_version'").run(); first.close()

    const migrated = new AppDatabase(path)
    expect(new ProjectService(migrated).get(project.id).title).toBe('旧版长篇')
    expect(new DocumentService(migrated).getContent(project.id, chapter.id).plainText).toBe('迁移前的正文不会丢失。')
    expect(new ChatService(migrated).listMessages(project.id, thread.id)[1].status).toBe('error')
    expect(new MemoryService(migrated).list(project.id)[0].content).toBe('旧记忆仍存在')
    const migratedProviders = new ProviderService(migrated, testCodec)
    expect(migratedProviders.list()[0].displayName).toBe('旧服务')
    expect(migratedProviders.listRoutes().proofreading).toBe('old-model')
    expect(migrated.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '3' })
    migrated.close()
  })
})
