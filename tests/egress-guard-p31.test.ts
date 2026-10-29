import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createProviderAdapter } from '../src/main/ai/provider'
import { EgressBlockedError, guardedFetch, installEgressGate } from '../src/main/net/egress-guard'
import { NetworkGate, originsFromProviderBaseUrls } from '../src/main/network-policy'

// P3-1：主进程 Node fetch 不经 session.webRequest；验证 egress-guard 统一守门。仅本地假服务器。
type Fake = { server: Server; base: string; origin: string; hits: number; handler: (url: string, res: import('node:http').ServerResponse) => void }
const makeFake = async (): Promise<Fake> => {
  const fake = { hits: 0, handler: () => undefined } as unknown as Fake
  fake.server = createServer((req, res) => {
    fake.hits += 1
    req.resume(); req.on('end', () => fake.handler(req.url ?? '', res))
  })
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve))
  fake.origin = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`
  fake.base = `${fake.origin}/v1`
  return fake
}
const openaiOk = (_u: string, res: import('node:http').ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })) }
const anthropicOk = (_u: string, res: import('node:http').ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 } })) }

let allowed: Fake; let outsider: Fake; let gate: NetworkGate
beforeAll(async () => { allowed = await makeFake(); outsider = await makeFake() })
afterAll(async () => { for (const f of [allowed, outsider]) { f.server.closeAllConnections(); await new Promise((r) => f.server.close(r)) } })
const reset = (): void => {
  gate = new NetworkGate(); gate.setSavedOrigins(originsFromProviderBaseUrls([allowed.base])); installEgressGate(gate)
  allowed.hits = 0; outsider.hits = 0; allowed.handler = openaiOk; outsider.handler = openaiOk
}
afterEach(() => installEgressGate(undefined))

describe('P3-1 主进程出站守门', () => {
  it('未安装门闸时 fail-closed：拒绝且假服务器 0 请求', async () => {
    allowed.hits = 0
    await expect(guardedFetch(`${allowed.base}/chat/completions`)).rejects.toBeInstanceOf(EgressBlockedError)
    expect(allowed.hits).toBe(0)
  })

  for (const type of ['openai-compatible', 'anthropic'] as const) {
    it(`${type}：非白名单地址被拒（中文提示），假服务器 0 请求`, async () => {
      reset(); outsider.handler = type === 'anthropic' ? anthropicOk : openaiOk
      const result = await createProviderAdapter(type, outsider.base, 'k').testConnection('m')
      expect(result.ok).toBe(false)
      expect(result.message).toContain('出站请求被拒绝')
      expect(outsider.hits).toBe(0)
      const chat = async () => { for await (const _ of createProviderAdapter(type, outsider.base, 'k').chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] })) void _ }
      await expect(chat()).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' })
      expect(outsider.hits).toBe(0)
    })

    it(`${type}：已配置地址正常可用`, async () => {
      reset(); allowed.handler = type === 'anthropic' ? anthropicOk : openaiOk
      expect(await createProviderAdapter(type, allowed.base, 'k').testConnection('m')).toEqual({ ok: true })
      expect(allowed.hits).toBe(1)
    })

    it(`${type}：已配置地址 302 重定向到外部地址被拒，外部服务器 0 请求`, async () => {
      reset()
      allowed.handler = (_u, res) => { res.writeHead(302, { location: `${outsider.base}/steal` }); res.end() }
      const result = await createProviderAdapter(type, allowed.base, 'k').testConnection('m')
      expect(result).toMatchObject({ ok: false })
      expect(result.message).toContain('重定向')
      expect(allowed.hits).toBe(1)
      expect(outsider.hits).toBe(0)
    })
  }

  it('测试连接：未保存地址仅在本次临时放行期间可达，撤销后再次被拒', async () => {
    reset()
    const revoke = gate.allowTemporarily(outsider.origin)
    expect(await createProviderAdapter('openai-compatible', outsider.base, '').testConnection('m')).toEqual({ ok: true })
    expect(outsider.hits).toBe(1)
    revoke()
    const again = await createProviderAdapter('anthropic', outsider.base, '').testConnection('m')
    expect(again.ok).toBe(false)
    expect(outsider.hits).toBe(1)
  })

  it('非 http(s) 协议直接拒绝', async () => {
    reset()
    await expect(guardedFetch('file:///etc/passwd')).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' })
    await expect(guardedFetch('data:text/plain,hi')).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' })
  })

  it('源码守卫：src/main 除 egress-guard 外不得出现裸 fetch / http(s) / net 外联', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
    const files = walk(join(__dirname, '../src/main')).filter((p) => p.endsWith('.ts') && !p.endsWith(join('net', 'egress-guard.ts')))
    const bad: string[] = []
    const patterns = [/(?<![\w.])fetch\s*\(/, /globalThis\.fetch/, /from ['"](node:)?(https?|net|http2|tls|dgram)['"]/, /require\(['"](node:)?(https?|net|http2|tls|dgram)['"]\)/, /\bnet\.request\b/, /\b(?:import|from)\b[^\n]*\bnet\b[^\n]*['"]electron['"]/]
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return
        if (patterns.some((re) => re.test(line))) bad.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })
})
