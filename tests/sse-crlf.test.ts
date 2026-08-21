import { describe, it, expect } from 'vitest'
import { OpenAICompatibleAdapter } from '../src/main/ai/provider'

// 回归：审计 H-1 —— SSE 事件边界需容忍 CRLF 行尾
const crlfChunks = [
  'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n',
  'data: {"choices":[{"delta":{"content":"，世界"}}]}\r\n\r\n',
  'data: [DONE]\r\n\r\n'
]
const lfChunks = [
  'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
  'data: [DONE]\n\n'
]

function fakeFetch(chunks: string[]) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      controller.close()
    }
  })
  const response = { ok: true, status: 200, body: stream }
  return (async () => response) as unknown as typeof fetch
}

async function collect(adapter: OpenAICompatibleAdapter): Promise<string> {
  let out = ''
  for await (const chunk of adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] })) out += chunk
  return out
}

describe('SSE 解析（审计 H-1 回归）', () => {
  it('LF 行尾正常解析', async () => {
    const adapter = new OpenAICompatibleAdapter('http://x', 'k', fakeFetch(lfChunks))
    expect(await collect(adapter)).toBe('你好，世界')
  })
  it('CRLF 行尾不再丢失正文', async () => {
    const adapter = new OpenAICompatibleAdapter('http://x', 'k', fakeFetch(crlfChunks))
    expect(await collect(adapter)).toBe('你好，世界')
  })
  it('跨 chunk 撕裂的 data 行仍正确缓冲', async () => {
    const torn = ['data: {"choices":[{"delta":{"con', 'tent":"撕裂"}}]}\n\ndata: [DONE]\n\n']
    const adapter = new OpenAICompatibleAdapter('http://x', 'k', fakeFetch(torn))
    expect(await collect(adapter)).toBe('撕裂')
  })
})
