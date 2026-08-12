import { describe, expect, it } from 'vitest'
import { ProviderService, routedTasks } from '../src/main/ai/provider'
import { createTestDb, testCodec } from './helpers'

describe('model routes', () => {
  it('round-trips all supported routes and falls back when a routed model is disabled', () => {
    const db = createTestDb(); const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: '自带服务', baseUrl: 'http://local.test/v1', apiKey: 'secret' })
    providers.saveModel({ id: 'default', providerId: 'p', modelId: 'writer', displayName: '主模型', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    providers.saveModel({ id: 'proof', providerId: 'p', modelId: 'proof', displayName: '校对模型', enabled: true, isDefault: false,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    expect(Object.keys(providers.listRoutes())).toEqual(routedTasks)
    providers.setRoute('proofreading', 'proof')
    expect(providers.listRoutes().proofreading).toBe('proof')
    expect(providers.route('proofreading').id).toBe('proof')
    providers.saveModel({ ...providers.listModels().find((model) => model.id === 'proof')!, enabled: false })
    expect(providers.listRoutes().proofreading).toBe('default')
    expect(providers.route('proofreading').id).toBe('default')
  })
})
