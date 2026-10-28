import { describe, expect, it, vi } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ADDRESS_CHANGED_KEY, ADDRESS_CHANGED_QUERY_SECRET, OpenAICompatibleAdapter, ProviderService } from '../src/main/ai/provider'
import { userErrorMessage } from '../src/shared/user-error'
import { providerInputSchema } from '../src/main/ipc/schemas'
import { displayBaseUrl, hasSecretQuery, redactBaseUrl, redactQuerySecrets, redactSecretsInText, restoreRedactedSecrets } from '../src/shared/base-url'

const S = 'SECRETQ9'
const names = ['key', 'api_key', 'apikey', 'token', 'access_token', 'secret', 'password', 'sig']
const save = (providers: ProviderService, baseUrl: string, apiKey?: string) =>
  providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'x', baseUrl, apiKey })
const okFetch = () => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 }))

describe('S1d query 中的密钥脱敏', () => {
  it('8 个参数名大小写不敏感地脱敏，其他参数保留', () => {
    for (const name of [...names, ...names.map((n) => n.toUpperCase()), 'Api_Key', 'Access_Token', 'api%5Fkey']) {
      const url = `https://api.example.com/v1?model=m&${name}=${S}&x=1`
      expect(redactQuerySecrets(url), name).toBe(`https://api.example.com/v1?model=m&${name}=***&x=1`)
      expect(displayBaseUrl(url), name).not.toContain(S)
      expect(hasSecretQuery(url), name).toBe(true)
    }
    expect(redactQuerySecrets(`https://h/v1?monkey=${S}&keys=a`)).toBe(`https://h/v1?monkey=${S}&keys=a`)
    expect(hasSecretQuery('https://h/v1?model=m')).toBe(false)
    expect(redactBaseUrl(`http://h/v1?key=${S}#frag`)).toBe('http://h/v1?key=***#frag')
  })

  it('保存时不拒绝（schema 与 service 都放行），providers:list 与 save 返回值都脱敏', () => {
    expect(providerInputSchema.safeParse({ id: 'p', providerType: 'openai-compatible', displayName: 'x', baseUrl: `https://h/v1?api_key=${S}` }).success).toBe(true)
    const db = createTestDb(); const providers = new ProviderService(db, testCodec)
    const saved = save(providers, `https://h/v1?api_key=${S}&Token=${S}2`, 'k')
    expect(JSON.stringify(saved)).not.toContain(S)
    expect(saved.baseUrl).toBe('https://h/v1?api_key=***&Token=***')
    expect(saved.baseUrlError).toBeUndefined()
    expect(JSON.stringify(providers.list())).not.toContain(S)
    expect(db.raw.prepare('SELECT base_url FROM provider_configs').get()).toEqual({ base_url: `https://h/v1?api_key=${S}&Token=${S}2` })
  })

  it('设置页编辑再保存：*** 按参数名还原为原值，不覆盖；新值可替换', () => {
    const db = createTestDb(); const providers = new ProviderService(db, testCodec)
    save(providers, `https://h/v1?key=${S}&sig=${S}B`, 'k')
    const shown = providers.list()[0].baseUrl
    save(providers, shown.replace('model', 'x'))
    save(providers, shown)
    expect(db.raw.prepare('SELECT base_url FROM provider_configs').get()).toEqual({ base_url: `https://h/v1?key=${S}&sig=${S}B` })
    save(providers, 'https://h/v1/?key=NEWVALUE&sig=***')
    expect(db.raw.prepare('SELECT base_url FROM provider_configs').get()).toEqual({ base_url: `https://h/v1?key=NEWVALUE&sig=${S}B` })
  })

  it('没有原值可还原时拒绝保存，绝不写入 ***', () => {
    const db = createTestDb(); const providers = new ProviderService(db, testCodec)
    expect(() => save(providers, 'https://h/v1?key=***', 'k')).toThrow('找不到原值')
    expect(providers.list()).toEqual([])
    save(providers, 'https://h/v1?model=m', 'k')
    expect(() => save(providers, 'https://h/v1?model=m&token=***')).toThrow('找不到原值')
    expect(restoreRedactedSecrets('https://h?key=***&key=***', `https://h?key=a&key=b`)).toBe('https://h?key=a&key=b')
  })

  it('实际请求保留原值（端点追加在 path 上，query 原样在末尾）', async () => {
    const db = createTestDb(); const providers = new ProviderService(db, testCodec)
    save(providers, `http://127.0.0.1:11434/v1?api_key=${S}`, 'k')
    const { config } = providers.getWithSecret('p')
    const fetcher = okFetch()
    const adapter = new OpenAICompatibleAdapter(config.baseUrl, 'k', fetcher as unknown as typeof fetch)
    await expect(adapter.testConnection('m')).resolves.toEqual({ ok: true })
    expect(fetcher.mock.calls[0][0]).toBe(`http://127.0.0.1:11434/v1/chat/completions?api_key=${S}`)
  })

  it('网络报错的 message/details 不含密钥', async () => {
    const fetcher = vi.fn(async (url: string) => { throw new TypeError(`fetch failed for ${url}`) })
    const adapter = new OpenAICompatibleAdapter(`http://127.0.0.1:1/v1?token=${S}&x=1`, 'k', fetcher as unknown as typeof fetch)
    let thrown: unknown
    try { await adapter.complete({ model: 'm', messages: [] }) } catch (error) { thrown = error }
    expect(JSON.stringify({ message: (thrown as Error).message, details: (thrown as { details?: string }).details })).not.toContain(S)
    expect((thrown as { details?: string }).details).toContain('token=***')
    const result = await adapter.testConnection('m')
    expect(JSON.stringify(result)).not.toContain(S)
    expect(redactSecretsInText(`GET http://h/v1?Password=${S} failed; "sig=${S}"`)).not.toContain(S)
  })

  describe('S1d-A/A2/D/E 还原与沿用绑定地址', () => {
    const rows = (db: ReturnType<typeof createTestDb>) => db.raw.prepare('SELECT base_url FROM provider_configs').all()

    it('A：host 改成 evil.example 后带 *** 保存被拒绝，原值不变且不发出任何请求', async () => {
      const db = createTestDb(); const providers = new ProviderService(db, testCodec)
      save(providers, `https://h.example/v1?model=m&key=${S}&sig=${S}B`, 'k')
      const before = rows(db)
      const shown = providers.list()[0].baseUrl
      const fetcher = okFetch()
      for (const evil of [shown.replace('h.example', 'evil.example'), shown.replace('https://h.example', 'http://h.example'),
        shown.replace('h.example', 'h.example:8443'), shown.replace('/v1', '/steal')]) {
        expect(() => save(providers, evil)).toThrow(ADDRESS_CHANGED_QUERY_SECRET)
        expect(() => save(providers, evil, 'new-bearer')).toThrow(ADDRESS_CHANGED_QUERY_SECRET)
      }
      expect(rows(db)).toEqual(before)
      expect(fetcher).not.toHaveBeenCalled()
      // 之后按已存配置真实发起请求：只会发往原 host，evil.example 从未收到请求
      const { config } = providers.getWithSecret('p')
      await new OpenAICompatibleAdapter(config.baseUrl, 'k', fetcher as unknown as typeof fetch).testConnection('m')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(String(fetcher.mock.calls[0][0])).toMatch(/^https:\/\/h\.example\/v1\/chat\/completions/)
      expect(fetcher.mock.calls.some(([url]) => String(url).includes('evil'))).toBe(false)
      // 默认端口与大小写规范化后视为同一地址，可以还原
      save(providers, shown.replace('https://h.example', 'HTTPS://H.EXAMPLE:443'))
      expect(JSON.stringify(rows(db))).toContain(`key=${S}`)
    })

    it('A2：host 改成 evil.example 且未填新 Key 时拒绝沿用旧 Bearer Key，不发请求；填了新 Key 可保存', async () => {
      const db = createTestDb(); const providers = new ProviderService(db, testCodec)
      save(providers, 'https://h.example/v1', 'old-bearer')
      const before = rows(db)
      const fetcher = okFetch()
      for (const url of ['https://evil.example/v1', 'http://h.example/v1', 'https://h.example:8443/v1'])
        expect(() => save(providers, url)).toThrow(expect.objectContaining({ code: 'PROVIDER_KEY_REENTRY_REQUIRED', message: ADDRESS_CHANGED_KEY }))
      expect(rows(db)).toEqual(before)
      expect(fetcher).not.toHaveBeenCalled()
      // 之后按已存配置真实发起请求：只会发往原 host，evil.example 从未收到请求
      const { config } = providers.getWithSecret('p')
      await new OpenAICompatibleAdapter(config.baseUrl, 'k', fetcher as unknown as typeof fetch).testConnection('m')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(String(fetcher.mock.calls[0][0])).toMatch(/^https:\/\/h\.example\/v1\/chat\/completions/)
      expect(fetcher.mock.calls.some(([url]) => String(url).includes('evil'))).toBe(false)
      save(providers, 'https://h.example/v2') // 只改 path 可沿用
      save(providers, 'https://evil.example/v1', 'new-bearer')
      expect(rows(db)).toEqual([{ base_url: 'https://evil.example/v1' }])
    })

    it('D：新增参数名脱敏，相似名不误伤；E：空值不显示为 ***', () => {
      const db = createTestDb(); const providers = new ProviderService(db, testCodec)
      save(providers, `https://h/v1?api-key=${S}&client_secret=${S}&refresh_token=${S}&signature=${S}&AUTH=${S}&keyword=kw&key=`, 'k')
      const shown = providers.list()[0].baseUrl
      expect(shown).not.toContain(S)
      expect(shown).toBe('https://h/v1?api-key=***&client_secret=***&refresh_token=***&signature=***&AUTH=***&keyword=kw&key=')
      expect(redactSecretsInText(`GET /x?signature=${S}&auth=${S}&key= ok`)).toBe('GET /x?signature=***&auth=*** &key= ok'.replace('*** &', '***&'))
    })
  })

  it('设置页显示的是作者能看懂的文案，而非错误码或 IPC 包装', () => {
    const db = createTestDb(); const providers = new ProviderService(db, testCodec)
    save(providers, 'https://h.example/v1', 'old')
    let caught: unknown
    try { save(providers, 'https://evil.example/v1') } catch (error) { caught = error }
    // 模拟 Electron ipcRenderer.invoke 抛到渲染进程的格式
    const ipcError = new Error(`Error invoking remote method 'providers:save': Error: ${(caught as Error).message}`)
    const shown = `操作失败：${userErrorMessage(ipcError)}`
    expect(shown).toBe('操作失败：地址已变更，为防止密钥发往新地址，请重新填写 Key。')
    expect(shown).not.toMatch(/PROVIDER_|Error|invoking/)
    expect(userErrorMessage(new Error('普通错误'))).toBe('普通错误')
  })
})
