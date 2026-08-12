import { describe, expect, it, vi } from 'vitest'
import { AIEventRouter } from '../src/preload/ai-event-router'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { ProviderService } from '../src/main/ai/provider'
import { ProjectService } from '../src/main/services/project-service'
import { ChatService } from '../src/main/services/chat-service'
import { createTestDb, testCodec } from './helpers'

describe('AI request event isolation', () => {
  it('routes concurrent streams only to their own callbacks', () => {
    const router = new AIEventRouter(); const a: string[] = []; const b: string[] = []
    router.register('A', (event) => { if (event.type === 'chunk') a.push(event.chunk) })
    router.register('B', (event) => { if (event.type === 'chunk') b.push(event.chunk) })
    router.dispatch({ type: 'chunk', requestId: 'A', chunk: 'A1' }); router.dispatch({ type: 'chunk', requestId: 'B', chunk: 'B1' })
    router.dispatch({ type: 'chunk', requestId: 'A', chunk: 'A2' }); router.dispatch({ type: 'done', requestId: 'A' })
    router.dispatch({ type: 'chunk', requestId: 'B', chunk: 'B2' }); router.dispatch({ type: 'done', requestId: 'B' })
    expect(a).toEqual(['A1', 'A2']); expect(b).toEqual(['B1', 'B2'])
  })

  it('unregistering one request does not affect another', () => {
    const router = new AIEventRouter(); const a = vi.fn(); const b = vi.fn()
    const cancelA = router.register('A', a); router.register('B', b); cancelA()
    router.dispatch({ type: 'chunk', requestId: 'A', chunk: 'ignored' }); router.dispatch({ type: 'chunk', requestId: 'B', chunk: 'kept' })
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledOnce()
  })

  it('releases the request id when setup fails before streaming starts', async () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '请求清理', projectType: 'novel' })
    const runtime = new AICreativeRuntime(db, new ProviderService(db, testCodec))
    const thread = new ChatService(db).createThread(project.id, '失败测试')
    const task = { mode: 'discussion' as const, writePermission: 'none' as const,
      userIntent: '测试失败后的清理', projectId: project.id }

    await expect(runtime.run('reusable-id', task, thread.id, 'user-1', 'assistant-1')[Symbol.asyncIterator]().next()).rejects.toThrow('DEFAULT_MODEL_NOT_CONFIGURED')
    await expect(runtime.run('reusable-id', task, thread.id, 'user-2', 'assistant-2')[Symbol.asyncIterator]().next()).rejects.toThrow('DEFAULT_MODEL_NOT_CONFIGURED')
  })
})
