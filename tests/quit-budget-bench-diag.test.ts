// P3 PR-53 诊断（临时，合并前删除）：待回写量→退出预留段耗时；释放后首存改前/改后；只靠 main 现有维护（autocheckpoint + WalCheckpointer）时连续输入下待回写量峰值。只打日志。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { pendingBackfillBytes } from './helpers/wal-index'

vi.setConfig({ testTimeout: 900_000 })
const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'inkstone-qbench-')); dirs.push(d); return d }
const log = (tag: string, data: unknown): void => { process.stdout.write(`${tag} ${process.platform} ${JSON.stringify(data)}\n`) }
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (f: number): number => Math.round(s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)] * 100) / 100
  return { n: s.length, median: q(0.5), p95: q(0.95), max: q(1) }
}

const BOUND = 8 * 1024 * 1024
describe('只靠现有维护：连续输入下待回写量峰值', () => {
  // [场景, 保存次数, 间隔 ms, 每次正文重复次数]；句子 24 字，×200 ≈ 4800 字，×2000 ≈ 4.8 万字
  const cases: Array<[string, number, number, number]> = [
    ['typing-250ms', 160, 250, 200], ['bigchapter-burst', 300, 0, 2000], ['bigchapter-250ms', 120, 250, 2000],
    ['typing-250ms', 160, 250, 200], ['bigchapter-burst', 300, 0, 2000], ['bigchapter-250ms', 120, 250, 2000]
  ]
  cases.forEach(([name, n, gap, rep], k) => it(`${name}#${k}`, async () => {
    const path = join(tempDir(), 's.sqlite')
    const db = new AppDatabase(path)
    const project = new ProjectService(db).create({ title: '基准', projectType: 'novel', description: '' })
    const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    const save: number[] = []; const commit: number[] = []; const pend: Array<[number, number, number]> = []
    let skipped = 0; let overCount = 0; let firstOverAtMs = -1
    const t0 = performance.now()
    for (let i = 0; i < n; i += 1) {
      const text = `第${i}次保存` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(rep)
      const t = performance.now()
      docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: doc(text), plainText: text })
      save.push(performance.now() - t); commit.push(db.commits.at(-1)!.commitMs)
      try {
        const p = pendingBackfillBytes(path); const at = Math.round(performance.now() - t0)
        pend.push([i, at, p])
        if (p > BOUND) { overCount += 1; if (firstOverAtMs < 0) firstOverAtMs = at }
      } catch { skipped += 1 }
      if (gap > 0) await sleep(gap)
    }
    const vals = pend.map((x) => x[2])
    const peak = pend.reduce((m, x) => (x[2] > m[2] ? x : m), [0, 0, 0])
    const curve = pend.filter((_, j) => j % Math.max(1, Math.floor(pend.length / 12)) === 0).map((x) => `${x[0]}@${x[1]}ms:${x[2]}`)
    log('PEAKBENCH', { scenario: name, run: k, saves: n, gapMs: gap, chars: 24 * rep, totalMs: Math.round(performance.now() - t0),
      pendingPeakBytes: peak[2], peakAtSave: peak[0], peakAtMs: peak[1], pendingMedianBytes: stats(vals).median, overBoundCount: overCount, firstOverBoundAtMs: firstOverAtMs,
      skippedSamples: skipped, save: stats(save), commit: stats(commit), checkpointerRuns: db.checkpointer?.runs ?? 0, curve })
    await db.closeAsync()
    expect(save).toHaveLength(n)
  }))
})
