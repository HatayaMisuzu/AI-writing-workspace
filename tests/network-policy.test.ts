import { describe, expect, it } from 'vitest'
import {
  NetworkGate,
  decideNetworkRequest,
  originFromBaseUrl,
  originsFromProviderBaseUrls
} from '../src/main/network-policy'

describe('S2 network policy (§6)', () => {
  it('① 已配置 origin 放行，其他 origin 拒绝', () => {
    const saved = ['http://127.0.0.1:9']
    expect(decideNetworkRequest('http://127.0.0.1:9/v1/chat/completions', { savedOrigins: saved }).allow).toBe(true)
    expect(decideNetworkRequest('https://api.openai.com/v1/models', { savedOrigins: saved })).toEqual({
      allow: false, reason: 'origin-not-allowlisted'
    })
    expect(decideNetworkRequest('https://example.com/', { savedOrigins: saved }).allow).toBe(false)
  })

  it('放行 file://；devtools 仅开发', () => {
    expect(decideNetworkRequest('file:///tmp/app/index.html', { savedOrigins: [] }).allow).toBe(true)
    expect(decideNetworkRequest('devtools://devtools/bundled/inspector.html', { savedOrigins: [], isDev: true }).allow).toBe(true)
    expect(decideNetworkRequest('devtools://devtools/bundled/inspector.html', { savedOrigins: [], isDev: false })).toEqual({
      allow: false, reason: 'devtools-in-production'
    })
  })

  it('决策 11：未保存 origin 仅 temporaryOrigins 放行', () => {
    const unsaved = 'http://localhost:11434'
    expect(decideNetworkRequest(`${unsaved}/v1/models`, { savedOrigins: [] }).allow).toBe(false)
    expect(decideNetworkRequest(`${unsaved}/v1/models`, {
      savedOrigins: [], temporaryOrigins: [unsaved]
    }).allow).toBe(true)
  })

  it('originFromBaseUrl / originsFromProviderBaseUrls', () => {
    expect(originFromBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080')
    expect(originFromBaseUrl('https://api.example.com/v1?key=x')).toBe('https://api.example.com')
    expect(originFromBaseUrl('not-a-url')).toBeUndefined()
    expect([...originsFromProviderBaseUrls(['http://a.test/v1', 'http://a.test/v2', 'bad'])].sort()).toEqual(['http://a.test'])
  })

  it('NetworkGate：拦截记日志；临时放行可撤销', () => {
    const gate = new NetworkGate({ isDev: false })
    gate.setSavedOrigins(['http://fixture.local'])
    expect(gate.filter('http://fixture.local/v1').cancel).toBe(false)
    expect(gate.filter('https://evil.example/x').cancel).toBe(true)
    expect(gate.getBlockedCount()).toBe(1)
    expect(gate.getBlockedLog()[0].reason).toBe('origin-not-allowlisted')

    const revoke = gate.allowTemporarily('http://localhost:11434')
    expect(gate.filter('http://localhost:11434/v1/models').cancel).toBe(false)
    revoke()
    expect(gate.filter('http://localhost:11434/v1/models').cancel).toBe(true)
    expect(gate.getBlockedCount()).toBe(2)
  })
})
