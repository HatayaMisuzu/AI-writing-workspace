import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildL4Book, l4Task, runL4, L4_SCENARIOS } from './l4-overflow-fixture'
import { ContextEngine } from '../src/main/ai/context-engine'
import { readGlobalTemplateFile, MAX_GLOBAL_FILE_BYTES } from '../src/main/services/prompt-template-service'
import { OVERFLOW_TRUNCATED_NOTE, overflowSummary, stateAfterRequest } from '../src/renderer/src/services/context-sources'
import type { ContextOverflow } from '../src/shared/domain'

/** 在 base f5d422d 上用同一夹具实跑得到（见 PR 正文「md5 对照」）。未钉住时本分支必须逐字一致。 */
const BASE_MD5: Record<string, string> = {
  'consistency-66-settings': 'f98fb6d1ec915397313c53269309cea9',
  'discussion-20-memories': '9f9348d3a974a81c9dcc5735165e4ac5',
  'consistency-250-timeline': 'a4b202965bf63d373c0abb7273e52d27',
  'generation-12-characters': 'c6d155ca5174251d061bf413f0e6e738'
}
const group = (overflow: ContextOverflow[] | undefined, kind: ContextOverflow['kind']): ContextOverflow | undefined => overflow?.find((item) => item.kind === kind)
const snapIds = (snap: Record<string, unknown>): string[] => (snap.sources as Array<{ id: string }>).map((item) => item.id)

describe('L4 上限外相关条目可见、可钉住', () => {
  it('未钉住：实发 messages 的 md5 与 base 逐字一致（4 个场景）', async () => {
    for (const s of L4_SCENARIOS) {
      const b = buildL4Book(s.book)
      expect((await runL4(b.db, l4Task(b.project.id, b.chapterId, s.mode), s.name)).md5, s.name).toBe(BASE_MD5[s.name])
    }
  })

  it('66 条设定（一致性检查）：另有 6 条；钉住第 66 名后入选并排第一；清单 = snapshot = 实发', async () => {
    const b = buildL4Book({ settings: 66 })
    const base = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'consistency_check'), 'a')
    const g = group(base.preview.metadata.overflow, 'memory')!
    expect(g).toMatchObject({ label: '设定', limit: 60, total: 6, listTruncated: false })
    expect(overflowSummary(g)).toBe('另有 6 条相关设定因上限未带上')
    expect(g.items.map((item) => item.id)).toEqual(['set-0005', 'set-0004', 'set-0003', 'set-0002', 'set-0001', 'set-0000']) // 现有排序：最近更新
    expect(g.items[0].basis).toEqual(['已确认', '超出上限未带上'])
    expect(base.snapshot.overflow).toEqual([{ kind: 'memory', limit: 60, total: 6, ids: g.items.map((item) => item.id) }])
    const pinned = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'consistency_check', { includedIds: ['set-0000'] }), 'b')
    expect(pinned.context.items[0].id).toBe('set-0000')
    expect(pinned.context.items[0].basis).toContain('钉住')
    expect(group(pinned.context.metadata.overflow, 'memory')!.items.map((item) => item.id)).toEqual(['set-0006', 'set-0005', 'set-0004', 'set-0003', 'set-0002', 'set-0001'])
    expect(snapIds(pinned.snapshot)).toEqual(pinned.preview.items.map((item) => item.id))
    expect(snapIds(pinned.snapshot)).toEqual(pinned.context.items.map((item) => item.id))
    expect(JSON.stringify(pinned.sent)).toContain('设定0：赤霄剑相关设定第 0 条。')
    expect(JSON.stringify(pinned.sent)).not.toContain('设定6：') // 被挤出上限的第 61 名不发送
  })

  it('20 条相关记忆（创作类）：另有 8 条；钉住后入选并排第一', async () => {
    const b = buildL4Book({ memories: 20 })
    const base = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'discussion'), 'a')
    const g = group(base.preview.metadata.overflow, 'memory')!
    expect(g).toMatchObject({ label: '记忆', limit: 12, total: 8 })
    expect(base.preview.items.filter((item) => item.kind === 'memory')).toHaveLength(12)
    const target = g.items[g.items.length - 1].id
    expect(base.preview.items.some((item) => item.id === target)).toBe(false)
    const pinned = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'discussion', { includedIds: [target] }), 'b')
    expect(pinned.context.items[0].id).toBe(target)
    expect(group(pinned.context.metadata.overflow, 'memory')!.items.some((item) => item.id === target)).toBe(false)
    expect(snapIds(pinned.snapshot)).toEqual(pinned.context.items.map((item) => item.id))
    expect(JSON.stringify(pinned.sent)).toContain(`记忆${target.replace('mem-', '').replace(/^0+(?=\d)/, '')}：`)
    // 钉住仍只在本次对话：请求后保留，切换对话清空（沿用 P3-e）
    expect(stateAfterRequest({ excludedIds: [], includedIds: [target] }).includedIds).toEqual([target])
  })

  it('100 条相关记忆：展开列表最多 50 条并注明', async () => {
    const b = buildL4Book({ memories: 100 })
    const g = group(new ContextEngine(b.db).build(l4Task(b.project.id, b.chapterId, 'discussion')).metadata.overflow, 'memory')!
    expect(g.total).toBe(88); expect(g.items).toHaveLength(50); expect(g.listTruncated).toBe(true)
    expect(OVERFLOW_TRUNCATED_NOTE).toBe('仅显示前 50 条')
  })

  it('人物卡超过 8 条被提及：另有 4 条；钉住后入选', async () => {
    const b = buildL4Book({ characters: 12 })
    const engine = new ContextEngine(b.db)
    const g = group(engine.build(l4Task(b.project.id, b.chapterId, 'generation')).metadata.overflow, 'character')!
    expect(g).toMatchObject({ label: '人物卡', limit: 8, total: 4 })
    const target = g.items[3].id
    const pinned = engine.build(l4Task(b.project.id, b.chapterId, 'generation', { includedIds: [target] }))
    expect(pinned.items[0].id).toBe(target)
  })

  it('250 条时间线：另有 50 条；钉住第 231 条后进入候选（修复 LIMIT 200），排第一且保留真实顺序号', async () => {
    const b = buildL4Book({ timeline: 250 })
    const base = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'consistency_check'), 'a')
    const g = group(base.preview.metadata.overflow, 'timeline')!
    expect(g).toMatchObject({ label: '时间线', limit: 200, total: 50, listTruncated: false })
    expect(g.items[0].id).toBe('tl-00200')
    expect(base.preview.items.filter((item) => item.kind === 'timeline')).toHaveLength(200)
    const pinned = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'consistency_check', { includedIds: ['tl-00230'] }), 'b')
    expect(pinned.context.items[0]).toMatchObject({ id: 'tl-00230', kind: 'timeline' })
    expect(pinned.context.items[0].content).toContain('顺序：第 231 个事件')
    expect(pinned.context.items.filter((item) => item.kind === 'timeline')).toHaveLength(201)
    expect(group(pinned.context.metadata.overflow, 'timeline')!.total).toBe(49)
    expect(snapIds(pinned.snapshot)).toEqual(pinned.context.items.map((item) => item.id))
  })

  it('窗口预算不够：钉住的上限外条目优先入选，其余照常裁剪并标「预算不足省略」', () => {
    const b = buildL4Book({ memories: 20, longMemories: true })
    const engine = new ContextEngine(b.db)
    const target = group(engine.build(l4Task(b.project.id, b.chapterId, 'discussion')).metadata.overflow, 'memory')!.items[7].id
    const tight = engine.build(l4Task(b.project.id, b.chapterId, 'discussion', { includedIds: [target] }), 600)
    expect(tight.items[0].id).toBe(target)
    expect((tight.metadata.omitted ?? []).filter((item) => item.reason === 'budget').length).toBeGreaterThan(0)
  })

  it('粗测：5000 条记忆 + 2000 条时间线 + 3000 条设定，清单构建耗时', () => {
    const b = buildL4Book({ memories: 5000, timeline: 2000, settings: 3000 })
    const engine = new ContextEngine(b.db)
    const time = (fn: () => void): number => { const t0 = performance.now(); fn(); return performance.now() - t0 }
    const creative = time(() => engine.build(l4Task(b.project.id, b.chapterId, 'discussion')))
    const consistency = time(() => engine.build(l4Task(b.project.id, b.chapterId, 'consistency_check')))
    if (process.env.L4_PERF_OUT) appendFileSync(process.env.L4_PERF_OUT, `discussion=${creative.toFixed(1)}ms consistency_check=${consistency.toFixed(1)}ms\n`)
    expect(creative).toBeLessThan(5_000); expect(consistency).toBeLessThan(5_000)
  }, 60_000)
})

describe('L8：导入全局模板先 stat', () => {
  it('超过 1MB 直接拒绝（中文），不读文件；正常文件可读', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'l8-'))
    try {
      const big = join(dir, 'big.aiwprompts'); await writeFile(big, Buffer.alloc(MAX_GLOBAL_FILE_BYTES + 1, 0x20))
      const fs = await import('node:fs/promises')
      const readSpy = vi.fn(async () => 'never')
      await expect(readGlobalTemplateFile(big, { stat: fs.stat, readFile: readSpy })).rejects.toThrow('文件超过 1MB')
      expect(readSpy).not.toHaveBeenCalled()
      const ok = join(dir, 'ok.aiwprompts'); await writeFile(ok, '{"a":1}')
      expect(await readGlobalTemplateFile(ok)).toBe('{"a":1}')
      await expect(readGlobalTemplateFile(dir)).rejects.toThrow('不是普通文件')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
