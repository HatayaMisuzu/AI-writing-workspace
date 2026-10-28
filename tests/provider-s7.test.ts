import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb, testCodec } from './helpers'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database/database'
import { ProviderService, OpenAICompatibleAdapter } from '../src/main/ai/provider'
import { ContextEngine } from '../src/main/ai/context-engine'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { ChatService } from '../src/main/services/chat-service'
import {
  PROVIDER_PRESETS, computeContextInputBudget, CONTEXT_BUDGET_MARGIN,
  DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, isLocalBaseUrl,
  LOCAL_FIRST_TOKEN_TIMEOUT_MS, REMOTE_FIRST_TOKEN_TIMEOUT_MS, localConnectionErrorMessage
} from '../src/shared/provider-presets'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const sseChunk = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`

describe('S7 Provider 预设 / 空 key / 超时 / 上下文窗口', () => {
  it('迁移领号 v6：model_configs 含 context_window / max_output', async () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(6)
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-s7-mig-'))
    try {
      const path = join(dir, 'v5.sqlite')
      const first = new AppDatabase(path)
      expect(first.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '6' })
      // 模拟从 v5 升级：写回 5 并去掉列不可行（SQLite），改为手工建旧表
      first.close()
      await rm(path, { force: true })
      const raw = new DatabaseSync(path)
      raw.exec(`
        CREATE TABLE app_settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO app_settings VALUES ('schema_version', '5', 1);
        CREATE TABLE provider_configs(
          id TEXT PRIMARY KEY, provider_type TEXT NOT NULL, display_name TEXT NOT NULL,
          base_url TEXT NOT NULL, encrypted_api_key BLOB, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE model_configs(
          id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL,
          capabilities_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
          UNIQUE(provider_id, model_id)
        );
      `)
      raw.close()
      const migrated = new AppDatabase(path)
      const cols = (migrated.raw.prepare('PRAGMA table_info(model_configs)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toContain('context_window')
      expect(cols).toContain('max_output')
      const pcols = (migrated.raw.prepare('PRAGMA table_info(provider_configs)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(pcols).toContain('first_token_timeout_ms')
      expect(pcols).toContain('total_timeout_ms')
      expect(migrated.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '6' })
      migrated.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('预设只填 Base URL，不内置任何 key；本地允许空 key', () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual(['ollama', 'lmstudio', 'openai', 'deepseek', 'openrouter', 'custom'])
    expect(PROVIDER_PRESETS.find((p) => p.id === 'ollama')?.baseUrl).toBe('http://localhost:11434/v1')
    expect(PROVIDER_PRESETS.find((p) => p.id === 'lmstudio')?.baseUrl).toBe('http://localhost:1234/v1')
    for (const preset of PROVIDER_PRESETS) {
      expect(preset).not.toHaveProperty('apiKey')
      expect(JSON.stringify(preset)).not.toMatch(/sk-[a-zA-Z0-9]/)
    }
    expect(PROVIDER_PRESETS.filter((p) => p.allowEmptyKey).map((p) => p.id).sort()).toEqual(['lmstudio', 'ollama'])
    expect(isLocalBaseUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLocalBaseUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('源码 grep：预设与共享模块无硬编码 key', () => {
    const root = join(process.cwd(), 'src')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name)
        if (name.isDirectory()) walk(path)
        else if (/\.(ts|tsx|mjs|js)$/.test(name.name)) {
          const text = readFileSync(path, 'utf8')
          // 排除测试夹具与注释里的示例词；查常见真实 key 形态
          if (/sk-(?:live|proj|ant)-[a-zA-Z0-9]{10,}/.test(text)) hits.push(path)
          if (/api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_-]{16,}['"]/i.test(text) && !path.includes('test')) hits.push(path)
        }
      }
    }
    walk(root)
    expect(hits).toEqual([])
    const presets = readFileSync(join(root, 'shared/provider-presets.ts'), 'utf8')
    // 预设对象本身不得带 key 字段赋值
    expect(presets).not.toMatch(/apiKey\s*:/)
    expect(presets).not.toMatch(/sk-[a-zA-Z0-9]/)
  })

  it('空 key + 本地 Base URL：可保存且流式成功；不触碰 encrypt', async () => {
    const db = createTestDb()
    let encryptCalls = 0
    const codec = {
      encrypt(value: string) { encryptCalls += 1; return testCodec.encrypt(value) },
      decrypt(value: Buffer) { return testCodec.decrypt(value) }
    }
    const providers = new ProviderService(db, codec)
    const saved = providers.save({
      id: 'local', providerType: 'openai-compatible', displayName: 'Ollama',
      baseUrl: 'http://localhost:11434/v1'
    })
    expect(saved.hasApiKey).toBe(false)
    expect(encryptCalls).toBe(0)
    const secret = providers.getWithSecret('local')
    expect(secret.apiKey).toBe('')

    const chunks: string[] = []
    const adapter = new OpenAICompatibleAdapter('http://localhost:11434/v1', '', async (_url, init) => {
      const headers = init?.headers as Record<string, string>
      expect(headers.authorization).toBeUndefined()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseChunk('你好')))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    for await (const chunk of adapter.chat({ model: 'llama', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
    expect(chunks.join('')).toBe('你好')

    // 远端空 key 仍拒绝
    providers.save({ id: 'remote', providerType: 'openai-compatible', displayName: 'Remote', baseUrl: 'https://api.example.com/v1' })
    expect(() => providers.getWithSecret('remote')).toThrow('PROVIDER_KEY_MISSING')
  })

  it('本地空 key 不需要加密存储：codec 不可用仍可保存无 key 的本地服务', () => {
    const db = createTestDb()
    const broken = {
      encrypt(): Buffer { throw new Error('SECURE_STORAGE_UNAVAILABLE') },
      decrypt(): string { throw new Error('SECURE_STORAGE_UNAVAILABLE') }
    }
    const providers = new ProviderService(db, broken)
    expect(() => providers.save({
      id: 'ollama', providerType: 'openai-compatible', displayName: 'Ollama',
      baseUrl: 'http://localhost:11434/v1'
    })).not.toThrow()
    expect(() => providers.save({
      id: 'ollama2', providerType: 'openai-compatible', displayName: 'Ollama2',
      baseUrl: 'http://localhost:11434/v1', apiKey: 'should-fail'
    })).toThrow('SECURE_STORAGE_UNAVAILABLE')
  })

  it('首 token 超时报错且可重试', async () => {
    let calls = 0
    const hang: typeof fetch = async () => {
      calls += 1
      const stream = new ReadableStream({ start() { /* 永不推送 */ } })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const adapter = new OpenAICompatibleAdapter('http://127.0.0.1:11434/v1', '', hang)
    await expect((async () => {
      for await (const _ of adapter.chat({
        model: 'm', messages: [{ role: 'user', content: 'x' }],
        firstTokenTimeoutMs: 40, timeoutMs: 5_000
      })) { void _ }
    })()).rejects.toMatchObject({ code: 'PROVIDER_FIRST_TOKEN_TIMEOUT', message: expect.stringContaining('请重试') })

    const ok = new OpenAICompatibleAdapter('http://127.0.0.1:11434/v1', '', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseChunk('重试成功')))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const parts: string[] = []
    for await (const chunk of ok.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], firstTokenTimeoutMs: 500 })) parts.push(chunk)
    expect(parts.join('')).toBe('重试成功')
    expect(calls).toBe(1)
  })

  it('本地服务未启动时报错文案含「无法连接 localhost:端口」', async () => {
    expect(localConnectionErrorMessage('http://localhost:11434/v1')).toBe('无法连接 localhost:11434')
    expect(localConnectionErrorMessage('http://127.0.0.1:1234/v1')).toBe('无法连接 localhost:1234')
    const adapter = new OpenAICompatibleAdapter('http://localhost:11434/v1', '', async () => {
      throw new TypeError('fetch failed')
    })
    const result = await adapter.testConnection('llama')
    expect(result.ok).toBe(false)
    expect(result.message).toBe('无法连接 localhost:11434')
  })

  it('预算计算：窗口 − 最大输出 − 余量；超出按优先级裁剪并标注已省略', () => {
    expect(computeContextInputBudget(10_000, 2_000)).toBe(10_000 - 2_000 - CONTEXT_BUDGET_MARGIN)
    expect(computeContextInputBudget(100, 90, 20)).toBe(0)
    expect(LOCAL_FIRST_TOKEN_TIMEOUT_MS).toBe(120_000)
    expect(REMOTE_FIRST_TOKEN_TIMEOUT_MS).toBe(60_000)

    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '预算', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({
      projectId: project.id, documentId: chapter.id,
      editorJson: { type: 'doc' },
      plainText: '正文'.repeat(2_000)
    })
    const engine = new ContextEngine(db)
    const budget = computeContextInputBudget(800, 200) // 800-200-256=344
    expect(budget).toBe(344)
    const tight = engine.build({
      mode: 'discussion', writePermission: 'none', userIntent: '看',
      projectId: project.id, documentId: chapter.id
    }, 8)
    // 预算极紧：要么整条省略，要么截断；清单须出现 budget 已省略或 truncated
    const omittedBudget = (tight.metadata.omitted ?? []).some((item) => item.reason === 'budget')
    const truncated = tight.items.some((item) => item.truncated)
    expect(omittedBudget || truncated).toBe(true)
    expect(tight.metadata.estimatedTokens).toBeLessThanOrEqual(20)
  })

  it('runtime 使用模型 contextWindow/maxOutput 计算预算', async () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '窗口', projectType: 'novel' })
    const chapter = new DocumentService(db).listOrderedChapters(project.id)[0]
    new DocumentService(db).saveContent({
      projectId: project.id, documentId: chapter.id,
      editorJson: { type: 'doc' }, plainText: '章内文字'
    })
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'f', baseUrl: 'http://localhost:9/v1' })
    providers.saveModel({
      id: 'm', providerId: 'p', modelId: 'm', displayName: 'm', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true },
      contextWindow: 8_000, maxOutput: 1_000
    })
    const thread = new ChatService(db).createThread(project.id)
    const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function * () { yield 'ok' } }))
    const preview = runtime.previewContext({
      mode: 'discussion', writePermission: 'none', userIntent: '问', projectId: project.id, documentId: chapter.id
    }, thread.id)
    // 输入预算上限约为 8000-1000-256=6744；预览 tokens 应远小于窗口
    expect(preview.metadata.estimatedTokens).toBeLessThan(computeContextInputBudget(8_000, 1_000))
    expect(DEFAULT_CONTEXT_WINDOW).toBe(16_000)
    expect(DEFAULT_MAX_OUTPUT).toBe(4_096)
  })

  it('可配置超时写入 provider 并 resolve', () => {
    const db = createTestDb()
    const providers = new ProviderService(db, testCodec)
    providers.save({
      id: 'p', providerType: 'openai-compatible', displayName: 'x',
      baseUrl: 'http://localhost:11434/v1', firstTokenTimeoutMs: 12_000, totalTimeoutMs: 99_000
    })
    expect(providers.resolveTimeouts('p')).toEqual({ firstTokenTimeoutMs: 12_000, totalTimeoutMs: 99_000 })
    providers.save({
      id: 'r', providerType: 'openai-compatible', displayName: 'r',
      baseUrl: 'https://api.example.com/v1', apiKey: 'k'
    })
    expect(providers.resolveTimeouts('r').firstTokenTimeoutMs).toBe(REMOTE_FIRST_TOKEN_TIMEOUT_MS)
  })
})
