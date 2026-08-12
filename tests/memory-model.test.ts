import { describe, expect, it } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ProviderService } from '../src/main/ai/provider'

describe('memory authority and model routing', () => {
  it('requires an explicit user actor before confirming memory', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '边界', projectType: 'novel' }); const service = new MemoryService(db)
    const item = service.create({ projectId: project.id, type: 'decision', content: 'A 是凶手', status: 'suggested', sourceType: 'chat', sourceId: 'x' })
    expect(() => service.confirm(project.id, item.id, 'ai' as 'user')).toThrow('CONFIRMED_REQUIRES_USER')
    expect(service.list(project.id)[0].status).toBe('suggested')
    expect(service.confirm(project.id, item.id, 'user').status).toBe('confirmed')
  })

  it('keeps all tasks on the default model until the user configures a route', () => {
    const db = createTestDb(); const service = new ProviderService(db, testCodec)
    const provider = service.save({ id: 'p', providerType: 'openai-compatible', displayName: '自带服务', baseUrl: 'https://example.test/v1', apiKey: 'secret' })
    const caps = { streaming: true, tools: false, structuredOutput: false, cancellation: true }
    service.saveModel({ id: 'a', providerId: provider.id, modelId: 'model-a', displayName: 'A', capabilities: caps, enabled: true, isDefault: true })
    service.saveModel({ id: 'b', providerId: provider.id, modelId: 'model-b', displayName: 'B', capabilities: caps, enabled: true, isDefault: false })
    expect(service.route('discussion').id).toBe('a')
    expect(service.route('proofreading').id).toBe('a')
    service.setRoute('proofreading', 'b')
    expect(service.route('discussion').id).toBe('a')
    expect(service.route('proofreading').id).toBe('b')
  })

  it('never advertises unsupported tools or native structured output', () => {
    const db = createTestDb(); const service = new ProviderService(db, testCodec)
    const provider = service.save({ id: 'p', providerType: 'openai-compatible', displayName: '兼容服务', baseUrl: 'https://example.test/v1', apiKey: 'secret' })
    const model = service.saveModel({ id: 'm', providerId: provider.id, modelId: 'model', displayName: 'Model',
      capabilities: { streaming: true, cancellation: true, tools: true, structuredOutput: true }, enabled: true, isDefault: true })
    expect(model.capabilities).toEqual({ streaming: true, cancellation: true, tools: false, structuredOutput: false })
    expect(service.listModels()[0].capabilities.tools).toBe(false)
  })
})
