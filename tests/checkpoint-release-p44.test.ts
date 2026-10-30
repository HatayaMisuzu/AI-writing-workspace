import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, type AppDatabaseOptions } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { WritingDailyService } from '../src/main/services/writing-daily-service'

// P3 PR-44（组长 2026-10-30 20:52）：暂停释放条件 = 某轮 checkpointed == log 且该轮期间主连接无新写入（写入代数）；
// 暂停期间写入合并补做；上限 maxRounds / maxMs 降级并告警。诊断 run 41055697997：检查点期间的保存让 WAL 无法复用，
// 释放后第一次普通保存的 COMMIT 同步做检查点（Windows 6263ms）。
// 以下沿用 PR-2b 背景：
// 根因（exp-commit-profile run 41037852801）：产品库是 WAL + NORMAL；千章 COMMIT 本身约 70ms，慢在 COMMIT 内自动 WAL 检查点
// （约 54MB 写回主库 + fsync），Windows C: 盘 2.7–4.1s。临时目录 tmpdir() 在 Windows runner 上就是 C:\Users\...\Temp。

type Stage = 'snapshot' | 'write'
class FaultyDocuments extends DocumentService {
  fault?: { stage: Stage; index: number; message?: string }
  protected override onBatchStep(stage: Stage, index: number): void {
    if (this.fault && this.fault.stage === stage && this.fault.index === index) throw new Error(this.fault.message ?? `INJECTED_${stage}_${index}`)
  }
}
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const body = (i: number): string => `第${i + 1}章：` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(120)
const meta = { query: '远处灯', replacement: '远处星', regex: false, caseSensitive: false }
const ORIGINAL = 777
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 })

const dirs: string[] = []
const dbs: AppDatabase[] = []
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.closeAsync().catch(() => undefined)
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'inkstone-rel-')); dirs.push(dir); return dir }

function setup(count: number, options: AppDatabaseOptions = {}, path = join(tempDir(), 'inkstone.sqlite')) {
  const db = new AppDatabase(path, options); dbs.push(db)
  const daily = new WritingDailyService(db)
  const docs = new FaultyDocuments(db, daily)
  const project = new ProjectService(db).create({ title: '检查点书', projectType: 'novel', description: '' })
  const tree = docs.listTree(project.id)
  const volume = tree.find((n) => n.type === 'volume')!
  const ids = [tree.find((n) => n.type === 'chapter')!.id]
  for (let i = 1; i < count; i += 1) ids.push(docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: `第${i + 1}章` }).id)
  ids.forEach((id, i) => docs.saveContent({ projectId: project.id, documentId: id, editorJson: doc(body(i)), plainText: body(i) }))
  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.raw.exec(`PRAGMA wal_autocheckpoint = ${ORIGINAL}`)
  return { db, docs, project, ids, path }
}
type S = ReturnType<typeof setup>
const items = (s: S, from = '远处灯', to = '远处星') => s.ids.map((id) => {
  const current = s.docs.getContent(s.project.id, id)
  const text = current.plainText.replaceAll(from, to)
  return { documentId: id, expectedRevision: current.revision, editorJson: doc(text), plainText: text, hits: 240 }
})
const lastCommit = (s: S) => s.db.commits[s.db.commits.length - 1]
const log = (line: string): void => { process.stdout.write(`P3 checkpoint-release ${process.platform}: ${line}\n`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 批量提交后每 intervalMs 保存一次 第2章，直到释放循环结束（或 stopMs）；返回保存次数 */
async function saveEvery(s: S, intervalMs: number, stopMs: number): Promise<number> {
  const started = performance.now(); let n = 0
  while (s.db.autoCheckpoint === 0 && performance.now() - started < stopMs) {
    await sleep(intervalMs)
    if (s.db.autoCheckpoint !== 0) break
    save(s, s.ids[1], `+${n}`); n += 1
  }
  return n
}
const save = (s: S, id: string, suffix: string): void => {
  const current = s.docs.getContent(s.project.id, id)
  s.docs.saveContent({ projectId: s.project.id, documentId: id, editorJson: doc(current.plainText + suffix), plainText: current.plainText + suffix, expectedRevision: current.revision })
}

describe('G：检查点期间持续写入（每 700ms 一次保存）', () => {
  it('首轮被写入打断（quiet=false）→ 补做轮收敛释放；释放后第一次保存 COMMIT < 50ms', async () => {
    const s = setup(300, { checkpointer: { inject: { delaySchedule: [1500] } } })
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    expect(s.db.autoCheckpoint).toBe(0)
    const saves = await saveEvery(s, 700, 20_000)
    await s.db.checkpointIdle()
    const rel = s.db.releases[s.db.releases.length - 1]
    log(`converge: saves during hold=${saves} rounds=${rel.rounds} ms=${rel.ms} reason=${rel.reason} writes=${rel.writesDuringHold}`)
    expect(saves).toBeGreaterThanOrEqual(1)
    expect(rel.reason).toBe('quiet')
    expect(rel.rounds).toBeGreaterThanOrEqual(2)
    expect(s.db.checkpointer!.last).toMatchObject({ ok: true, quiet: true })
    expect(s.db.checkpointer!.last!.checkpointed).toBe(s.db.checkpointer!.last!.log)
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    save(s, s.ids[1], '释放后')
    const first = lastCommit(s)
    log(`first save after release: commitMs=${first.commitMs} autoCheckpoint=${first.autoCheckpoint}`)
    expect(first.autoCheckpoint).toBe(true)
    expect(first.commitMs).toBeLessThan(50)
  })
  it('无注入延迟：每 700ms 保存，自然收敛所需轮数与时间（记日志）', async () => {
    const s = setup(1000)
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    const saves = await saveEvery(s, 700, 30_000)
    await s.db.checkpointIdle()
    const rel = s.db.releases[s.db.releases.length - 1]
    save(s, s.ids[1], '释放后')
    log(`natural 1000ch: saves=${saves} rounds=${rel.rounds} ms=${rel.ms} reason=${rel.reason} firstCommitMs=${lastCommit(s).commitMs}`)
    expect(rel.reason).toBe('quiet')
    expect(lastCommit(s).commitMs).toBeLessThan(50)
  })
})

describe('H：持续写入达上限 → 降级恢复 autocheckpoint 并告警', () => {
  it('轮数上限：每轮 400ms、每 150ms 保存 → limit-rounds，恢复原值，warnings 有降级告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const s = setup(50, { checkpointer: { inject: { delayMs: 400 } }, release: { maxRounds: 3 } })
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    await saveEvery(s, 150, 20_000)
    await s.db.checkpointIdle()
    const rel = s.db.releases[s.db.releases.length - 1]
    log(`limit-rounds: rounds=${rel.rounds} ms=${rel.ms} writes=${rel.writesDuringHold}`)
    expect(rel.reason).toBe('limit-rounds')
    expect(rel.rounds).toBeGreaterThanOrEqual(3)
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    expect(s.db.checkpointer!.warnings.some((w) => w.includes('release degraded (limit-rounds)'))).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
  it('时间上限：maxMs=1500 → limit-ms，恢复原值并告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const s = setup(50, { checkpointer: { inject: { delayMs: 400 } }, release: { maxMs: 1500 } })
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    await saveEvery(s, 150, 20_000)
    await s.db.checkpointIdle()
    const rel = s.db.releases[s.db.releases.length - 1]
    expect(rel.reason).toBe('limit-ms')
    expect(rel.ms).toBeGreaterThanOrEqual(1500)
    expect(rel.ms).toBeLessThan(1500 + 2000)
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    expect(s.db.checkpointer!.warnings.some((w) => w.includes('release degraded (limit-ms)'))).toBe(true)
    warn.mockRestore()
  })
  it('默认上限 10 轮 / 30s；降级频率：10 个批量 × 每 700ms 保存（无注入）', async () => {
    const s = setup(1000)
    let degraded = 0; const rounds: number[] = []
    for (let b = 0; b < 10; b += 1) {
      s.docs.replaceBatch({ projectId: s.project.id, items: items(s, b % 2 ? '远处星' : '远处灯', b % 2 ? '远处灯' : '远处星'), ...meta })
      await saveEvery(s, 700, 40_000)
      await s.db.checkpointIdle()
      const rel = s.db.releases[s.db.releases.length - 1]
      rounds.push(rel.rounds); if (rel.reason !== 'quiet') degraded += 1
    }
    log(`degrade frequency: ${degraded}/10 batches; rounds per batch=${rounds.join(',')}`)
    expect(Math.max(...rounds)).toBeLessThanOrEqual(10)
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
  }, 400_000)
})

describe('I：quiet===true 才释放（未提供 generation 不得误释放）', () => {
  it('currentRound 回报 quiet===undefined（模拟未提供 generation）→ 不按 quiet 释放，达轮数上限才降级', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const s = setup(30, { checkpointer: { inject: { delayMs: 80 }, retries: 0 }, release: { maxRounds: 2 } })
    const cp = s.db.checkpointer!
    const orig = cp.currentRound.bind(cp)
    vi.spyOn(cp, 'currentRound').mockImplementation(async () => {
      const outcome = await orig()
      if (!outcome) return outcome
      // 抹掉 quiet：等同于 WalCheckpointer 未提供 generation 时 quiet===undefined
      return { ...outcome, quiet: undefined }
    })
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    await s.db.checkpointIdle()
    const rel = s.db.releases[s.db.releases.length - 1]
    log(`no-generation: reason=${rel.reason} rounds=${rel.rounds} ms=${rel.ms}`)
    expect(rel.reason).toBe('limit-rounds')
    expect(rel.rounds).toBeGreaterThanOrEqual(2)
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    expect(s.db.checkpointer!.warnings.some((w) => w.includes('release degraded (limit-rounds)'))).toBe(true)
    warn.mockRestore()
  })

  it('源码守卫：释放条件必须是 outcome.quiet === true（不得用 !== false，避免 undefined 误释放）', () => {
    const src = readFileSync(resolve('src/main/database/database.ts'), 'utf8')
    expect(src).toMatch(/if \(outcome\.quiet === true\)/)
    expect(src).not.toMatch(/outcome\.quiet !== false/)
  })
})
