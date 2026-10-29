import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildL4Book, l4Task, runL4, L4_SCENARIOS } from './l4-overflow-fixture'
import { ContextEngine } from '../src/main/ai/context-engine'
import { readGlobalTemplateFile, MAX_GLOBAL_FILE_BYTES } from '../src/main/services/prompt-template-service'
import { OVERFLOW_TRUNCATED_NOTE, contextButtonLabel, isPinnable, overflowSummary, stateAfterRequest, toContextSourceRows } from '../src/renderer/src/services/context-sources'
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

/** 钉住的每一项都必须在清单里：已发送，或标「已省略（超出预算）」；不得静默消失。 */
const pinAccounting = (bundle: ReturnType<ContextEngine['build']>, pins: string[]) => {
  const rows = toContextSourceRows(bundle)
  const sent = pins.filter((id) => rows.some((row) => row.id === id && row.included))
  const budgetCut = pins.filter((id) => rows.some((row) => row.id === id && !row.included && row.omittedReason === 'budget'))
  const inOverflow = pins.filter((id) => (bundle.metadata.overflow ?? []).some((g) => g.items.some((item) => item.id === id)))
  return { sent, budgetCut, inOverflow, missing: pins.filter((id) => !sent.includes(id) && !budgetCut.includes(id)) }
}

describe('M1/M2/L4/L1：钉住不受数量上限，只受预算裁剪', () => {
  it('M1：钉住 13 张人物卡（创作类上限 8）全部发出；清单 = snapshot = 实发；按钮计数如实', async () => {
    const b = buildL4Book({ characters: 13 })
    const pins = Array.from({ length: 13 }, (_, i) => `ch-${String(i).padStart(3, '0')}`)
    const r = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'generation', { includedIds: pins }), 'm1')
    const acc = pinAccounting(r.context, pins)
    expect(acc).toMatchObject({ missing: [], inOverflow: [], budgetCut: [] }); expect(acc.sent).toHaveLength(13)
    expect(r.context.items.filter((item) => item.kind === 'character')).toHaveLength(13)
    expect(group(r.context.metadata.overflow, 'character')).toBeUndefined()
    expect(snapIds(r.snapshot)).toEqual(r.context.items.map((item) => item.id))
    expect(r.preview.items.map((item) => item.id)).toEqual(r.context.items.map((item) => item.id))
    for (const i of [0, 3, 12]) expect(JSON.stringify(r.sent)).toContain(`备注${i}`)
    expect(contextButtonLabel([], pins)).toBe('上下文（钉住 13）')
  })

  it('M1：钉住 13 张人物卡 + 紧预算：被裁的标「预算不足省略」，不进溢出、不消失', () => {
    const b = buildL4Book({ characters: 13, memories: 20, longMemories: true })
    const pins = Array.from({ length: 13 }, (_, i) => `ch-${String(i).padStart(3, '0')}`)
    const tight = new ContextEngine(b.db).build(l4Task(b.project.id, b.chapterId, 'generation', { includedIds: pins }), 700)
    const acc = pinAccounting(tight, pins)
    expect(acc.missing).toEqual([]); expect(acc.inOverflow).toEqual([])
    expect(acc.sent.length + acc.budgetCut.length).toBe(13)
    for (const id of acc.budgetCut) expect(toContextSourceRows(tight).find((row) => row.id === id)!.basis).toContain('预算不足省略')
  })

  it('创作类钉住 15 条记忆（上限 12）全部发出，溢出组不含钉住项', async () => {
    const b = buildL4Book({ memories: 30 })
    const pins = Array.from({ length: 15 }, (_, i) => `mem-${String(i).padStart(5, '0')}`)
    const r = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'discussion', { includedIds: pins }), 'mem15')
    const acc = pinAccounting(r.context, pins)
    expect(acc.sent).toHaveLength(15); expect(acc.missing).toEqual([]); expect(acc.inOverflow).toEqual([])
    expect(snapIds(r.snapshot)).toEqual(r.context.items.map((item) => item.id))
  })

  it('L4：一致性检查钉住全部 66 条设定（上限 60）全部发出；紧预算时被裁的标出', async () => {
    const b = buildL4Book({ settings: 66 })
    const pins = Array.from({ length: 66 }, (_, i) => `set-${String(i).padStart(4, '0')}`)
    const r = await runL4(b.db, l4Task(b.project.id, b.chapterId, 'consistency_check', { includedIds: pins }), 'l4')
    const acc = pinAccounting(r.context, pins)
    expect(acc.sent).toHaveLength(66); expect(acc.missing).toEqual([]); expect(group(r.context.metadata.overflow, 'memory')).toBeUndefined()
    for (const i of [0, 5, 65]) expect(JSON.stringify(r.sent)).toContain(`设定${i}：`)
    expect(snapIds(r.snapshot)).toEqual(r.context.items.map((item) => item.id))
    const tight = new ContextEngine(b.db).build(l4Task(b.project.id, b.chapterId, 'consistency_check', { includedIds: pins }), 300)
    const t = pinAccounting(tight, pins)
    expect(t.missing).toEqual([]); expect(t.budgetCut.length).toBeGreaterThan(0); expect(t.sent.length + t.budgetCut.length).toBe(66)
  })

  it('L4：一致性检查人物卡 40 / 时间线 200 上限同样不约束钉住项', () => {
    const b = buildL4Book({ characters: 45, timeline: 210 })
    const engine = new ContextEngine(b.db)
    const base = engine.build(l4Task(b.project.id, b.chapterId, 'consistency_check'))
    expect(group(base.metadata.overflow, 'character')!.total).toBe(5)
    const pins = [...Array.from({ length: 45 }, (_, i) => `ch-${String(i).padStart(3, '0')}`), 'tl-00205', 'tl-00209']
    const pinned = engine.build(l4Task(b.project.id, b.chapterId, 'consistency_check', { includedIds: pins }))
    expect(pinAccounting(pinned, pins)).toMatchObject({ missing: [], inOverflow: [] })
    expect(pinned.items.filter((item) => item.kind === 'character')).toHaveLength(45)
    expect(group(pinned.metadata.overflow, 'timeline')!.total).toBe(8)
  })

  it('M2：一致性检查的时间线 / 设定超限条目出现在清单数据里，且可钉住', () => {
    const b = buildL4Book({ settings: 66, timeline: 250 })
    const bundle = new ContextEngine(b.db).build(l4Task(b.project.id, b.chapterId, 'consistency_check'))
    const tl = group(bundle.metadata.overflow, 'timeline')!; const st = group(bundle.metadata.overflow, 'memory')!
    expect(overflowSummary(tl)).toBe('另有 50 条相关时间线因上限未带上'); expect(overflowSummary(st)).toBe('另有 6 条相关设定因上限未带上')
    for (const item of [...tl.items, ...st.items]) expect(isPinnable(item)).toBe(true)
  })

  it('L1：创作类超限记忆标题显示内容摘要', () => {
    const b = buildL4Book({ memories: 20 })
    const g = group(new ContextEngine(b.db).build(l4Task(b.project.id, b.chapterId, 'discussion')).metadata.overflow, 'memory')!
    for (const item of g.items) { expect(item.title).toMatch(/^记忆 · 记忆\d+：灵脉/); expect(item.title).toMatch(/（fact · (confirmed|observed)）$/) }
    expect(new Set(g.items.map((item) => item.title)).size).toBe(g.items.length)
  })
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
