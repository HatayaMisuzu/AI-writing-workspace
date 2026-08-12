import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { PatchService } from '../src/main/services/patch-service'
import { OpenAICompatibleAdapter } from '../src/main/ai/provider'
import { lintChineseText } from '../src/main/services/local-linter'

describe('patch safety, provider failures and local linter', () => {
  it('marks a patch stale when its target text changed and never overwrites it', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '补丁', projectType: 'novel' }); const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '风吹过旧码头。' })
    const patch = new PatchService(db).propose({ projectId: project.id, documentId: chapter.id, from: 0, to: 1, replacement: '雨' })
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '雾吹过旧码头。' })
    expect(new PatchService(db).apply(project.id, patch.id).status).toBe('stale')
    expect(docs.getContent(project.id, chapter.id).plainText).toBe('雾吹过旧码头。')
  })

  it('creates an ai_edit snapshot before applying a valid patch', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '补丁', projectType: 'novel' }); const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '风吹过旧码头。' })
    const service = new PatchService(db); const patch = service.propose({ projectId: project.id, documentId: chapter.id, from: 0, to: 1, replacement: '雨' })
    expect(service.apply(project.id, patch.id).status).toBe('accepted')
    expect(docs.getContent(project.id, chapter.id).plainText).toBe('雨吹过旧码头。')
    expect(docs.listSnapshots(project.id, chapter.id)[0].reason).toBe('ai_edit')
  })

  it('normalizes recoverable provider HTTP errors without document side effects', async () => {
    const adapter = new OpenAICompatibleAdapter('https://example.test/v1', 'secret', async () => new Response('', { status: 401 }) as never)
    const result = await adapter.testConnection('model')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('凭据无效')
    const limited = new OpenAICompatibleAdapter('https://example.test/v1', 'secret', async () => new Response('', { status: 429 }) as never)
    expect((await limited.testConnection('model')).message).toContain('请求过于频繁')
  })

  it('parses local SSE streaming without a real provider credential', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"潮"}}]}\n\n'))
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"声"}}]}\n\ndata: [DONE]\n\n'))
      controller.close()
    } })
    const adapter = new OpenAICompatibleAdapter('https://local.test/v1', 'unused', async () => new Response(body, { status: 200 }) as never)
    const chunks: string[] = []
    for await (const chunk of adapter.chat({ model: 'local-model', messages: [{ role: 'user', content: '测试' }] })) chunks.push(chunk)
    expect(chunks.join('')).toBe('潮声')
  })

  it('propagates cancellation and normalizes offline errors locally', async () => {
    const waitingFetcher = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as typeof fetch
    const controller = new AbortController()
    const stream = new OpenAICompatibleAdapter('https://local.test/v1', 'unused', waitingFetcher)
      .chat({ model: 'local-model', messages: [], signal: controller.signal })
    const pending = stream[Symbol.asyncIterator]().next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' })

    const offline = new OpenAICompatibleAdapter('https://offline.test/v1', 'unused', async () => { throw new TypeError('offline') })
    const result = await offline.testConnection('model')
    expect(result).toEqual({ ok: false, message: '无法连接模型服务，请检查网络与 Base URL。' })
  })

  it('detects lightweight Chinese punctuation issues locally', () => {
    const issues = lintChineseText('他说：“等等...  不要走！！')
    expect(issues.map((item) => item.kind)).toEqual(expect.arrayContaining(['ellipsis', 'repeated_punctuation', 'quote']))
  })
})
