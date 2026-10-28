import { describe, expect, it, vi } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { BASE_URL_MISSING_SCHEME, BASE_URL_UNSUPPORTED_SCHEME, checkBaseUrl } from '../src/shared/base-url'
import { OpenAICompatibleAdapter, ProviderService } from '../src/main/ai/provider'
import { providerInputSchema } from '../src/main/ipc/schemas'

const insertLegacy = (db: ReturnType<typeof createTestDb>, id: string, baseUrl: string): void => {
  db.raw.prepare(`INSERT INTO provider_configs (id, provider_type, display_name, base_url, encrypted_api_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, 'openai-compatible', '旧配置', baseUrl, testCodec.encrypt('secret'), 1, 1)
}

describe('S1c Base URL 只允许 http/https', () => {
  it('无协议地址给出明确提示', () => {
    for (const value of ['localhost:11434', 'localhost:11434/v1', '127.0.0.1:8080', 'api.example.com']) {
      expect(checkBaseUrl(value), value).toEqual({ ok: false, message: BASE_URL_MISSING_SCHEME })
    }
    const parsed = providerInputSchema.safeParse({ id: 'p', providerType: 'openai-compatible', displayName: 'x', baseUrl: 'localhost:11434' })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0].message).toContain('请在地址前加 http:// 或 https://')
  })

  it('非 http/https 协议被拒', () => {
    for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', 'mailto:a@b.com', 'ws://x', 'chrome://settings']) {
      expect(checkBaseUrl(value), value).toEqual({ ok: false, message: BASE_URL_UNSUPPORTED_SCHEME })
    }
  })

  it('http://localhost（含端口）与 https 可用，并去掉尾部斜杠', () => {
    expect(checkBaseUrl('http://localhost')).toEqual({ ok: true, url: 'http://localhost' })
    expect(checkBaseUrl(' http://localhost:11434/v1/ ')).toEqual({ ok: true, url: 'http://localhost:11434/v1' })
    expect(checkBaseUrl('https://api.example.com/v1').ok).toBe(true)
  })

  it('ProviderService.save 拒绝非法地址，不写库', () => {
    const db = createTestDb(); const providers = new ProviderService(db, testCodec)
    expect(() => providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'x', baseUrl: 'file:///etc/passwd', apiKey: 'k' })).toThrow('服务地址需要修正')
    expect(providers.list()).toEqual([])
    expect(providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'x', baseUrl: 'http://localhost:11434/v1/', apiKey: 'k' }).baseUrl).toBe('http://localhost:11434/v1')
  })

  it('存量非法地址：加载不崩、标记需修正、不解密不发请求、不删数据，修正后可用', async () => {
    const db = createTestDb(); const decrypt = vi.spyOn(testCodec, 'decrypt')
    insertLegacy(db, 'legacy', 'javascript:alert(1)')
    const providers = new ProviderService(db, testCodec)
    const listed = providers.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: 'legacy', baseUrl: 'javascript:alert(1)', baseUrlError: BASE_URL_UNSUPPORTED_SCHEME, hasApiKey: true })
    expect(() => providers.getWithSecret('legacy')).toThrow(expect.objectContaining({ code: 'PROVIDER_BASE_URL_INVALID' }))
    expect(decrypt).not.toHaveBeenCalled(); decrypt.mockRestore()
    const fetcher = vi.fn()
    expect(() => new OpenAICompatibleAdapter('file:///etc/passwd', 'k', fetcher as unknown as typeof fetch)).toThrow('服务地址需要修正')
    expect(fetcher).not.toHaveBeenCalled()
    // 数据未被静默删除，密钥保留；作者修正地址后（不重填密钥）即可使用
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM provider_configs').get()).toEqual({ n: 1 })
    providers.save({ id: 'legacy', providerType: 'openai-compatible', displayName: '旧配置', baseUrl: 'http://localhost:11434/v1' })
    expect(providers.list()[0].baseUrlError).toBeUndefined()
    expect(providers.list()[0].hasApiKey).toBe(true)
    expect(() => providers.getWithSecret('legacy')).not.toThrow()
  })

  it('存量无协议地址标记为缺协议提示', () => {
    const db = createTestDb(); insertLegacy(db, 'l2', 'localhost:11434')
    expect(new ProviderService(db, testCodec).list()[0].baseUrlError).toBe(BASE_URL_MISSING_SCHEME)
  })
})
