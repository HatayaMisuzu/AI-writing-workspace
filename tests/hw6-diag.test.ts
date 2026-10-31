// H-W6 诊断（仅诊断分支，不开 PR）：大章保存 COMMIT 长尾是否落在 autocheckpoint 同步回写的那次 COMMIT 上。只打日志。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { readWalState } from './helpers/wal-index'

vi.setConfig({ testTimeout: 1_200_000 })
const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'inkstone-hw6-')); dirs.push(d); return d }
const log = (tag: string, data: unknown): void => { process.stdout.write(`${tag} ${process.platform} ${JSON.stringify(data)}\n`) }
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const r2 = (x: number): number => Math.round(x * 100) / 100
const stats = (xs: number[]) => {
  if (xs.length === 0) return { n: 0, median: 0, p95: 0, max: 0 }
  const s = [...xs].sort((a, b) => a - b)
  const q = (f: number): number => r2(s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)])
  return { n: s.length, median: q(0.5), p95: q(0.95), max: q(1) }
}
type Snap = { ok: boolean; ckptSeq: number; mx: number; nb: number; page: number }
const snap = (path: string): Snap => {
  const s = readWalState(path)
  if (!s.wal.ok || !s.shm.ok) return { ok: false, ckptSeq: -1, mx: -1, nb: -1, page: 4096 }
  return { ok: true, ckptSeq: s.wal.value.ckptSeq, mx: s.shm.value.mxFrame, nb: s.shm.value.nBackfill, page: s.wal.value.pageSize }
}
const pending = (s: Snap): number => (s.ok ? (s.mx - s.nb) * (s.page + 24) : -1)

/** C 组触发条件：每次保存提交后，若待回写量 > C_THRESHOLD_BYTES 且 worker 空闲 → request 一次 PASSIVE（worker_threads 连接）。 */
const C_THRESHOLD_BYTES = 1024 * 1024
const SLOW_MS = 50
const SENT = '林舟看见远处灯，远处灯又亮了。风从北面吹来。' // 24 字
const REP = 2000 // ≈ 4.8 万字

type Group = 'A-1000' | 'B-200' | 'C-worker'
const groups: Group[] = ['A-1000', 'B-200', 'C-worker']
const scenarios: Array<[string, number, number]> = [['burst-300', 300, 0], ['gap250-120', 120, 250]]

describe('H-W6 大章保存 autocheckpoint 归因', () => {
  for (const [scen, n, gap] of scenarios) {
    for (const g of groups) {
      it(`${scen} ${g}`, async () => {
        const path = join(tempDir(), 's.sqlite')
        const passive: Array<{ ok: boolean; ms: number; overlapSaves: number }> = []
        let savesDuringPassive = 0
        const db = new AppDatabase(path, g === 'C-worker' ? { checkpointer: { onAttempt: (a) => { passive.push({ ok: a.ok, ms: r2(a.ms), overlapSaves: savesDuringPassive }); savesDuringPassive = 0 } } } : {})
        if (g === 'B-200') db.raw.exec('PRAGMA wal_autocheckpoint = 200')
        if (g === 'C-worker') db.raw.exec('PRAGMA wal_autocheckpoint = 0')
        const project = new ProjectService(db).create({ title: '大章', projectType: 'novel', description: '' })
        const docs = new DocumentService(db)
        const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
        const cp = db.checkpointer!
        const save: number[] = []; const commit: number[] = []
        const saveOverlap: number[] = []; const commitOverlap: number[] = []
        const slow: Array<Record<string, unknown>> = []
        let pendPeak = 0; let unread = 0; let backfillCommits = 0; let requests = 0
        const t0 = performance.now()
        for (let i = 0; i < n; i += 1) {
          const text = `第${i}次保存` + SENT.repeat(REP)
          const before = snap(path)
          const overlapping = g === 'C-worker' && cp.busy
          const t = performance.now()
          docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: doc(text), plainText: text })
          const saveMs = performance.now() - t
          const commitMs = db.commits.at(-1)!.commitMs
          const after = snap(path)
          if (cp.busy) savesDuringPassive += 1
          save.push(saveMs); commit.push(commitMs)
          if (overlapping) { saveOverlap.push(saveMs); commitOverlap.push(commitMs) }
          if (!before.ok || !after.ok) unread += 1
          // 本次提交期间主库被回写：nBackfill 增长（A/B = COMMIT 内 autocheckpoint；C = worker 并发）
          const restarted = before.ok && after.ok && after.ckptSeq !== before.ckptSeq
          const backfilled = before.ok && after.ok && (restarted ? after.nb > 0 : after.nb > before.nb)
          // A/B 组 COMMIT 内同步回写的特征：提交后 nBackfill == mxFrame（整段回写完）且本次之前未回写完
          const syncCkpt = g !== 'C-worker' && backfilled && after.nb === after.mx
          if (backfilled) backfillCommits += 1
          const p = pending(after); if (p > pendPeak) pendPeak = p
          if (commitMs > SLOW_MS || saveMs > SLOW_MS) {
            slow.push({ i, atMs: Math.round(t - t0), saveMs: r2(saveMs), commitMs, backfilled, syncCkpt, restarted, overlapping, before: `${before.ckptSeq}/${before.mx}/${before.nb}`, after: `${after.ckptSeq}/${after.mx}/${after.nb}` })
          }
          if (g === 'C-worker' && p > C_THRESHOLD_BYTES && !cp.busy) { requests += 1; void cp.request() }
          if (gap > 0) await sleep(gap)
        }
        await db.checkpointIdle()
        const slowBackfill = slow.filter((s) => s.backfilled).length
        log('HW6', {
          scenario: scen, group: g, saves: n, gapMs: gap, totalMs: Math.round(performance.now() - t0),
          save: stats(save), commit: stats(commit), backfillCommits, unreadSnaps: unread,
          slowCount: slow.length, slowOnBackfill: slowBackfill, slowNoBackfill: slow.length - slowBackfill,
          pendingPeakBytes: pendPeak,
          ...(g === 'C-worker' ? { requests, passive: stats(passive.map((x) => x.ms)), passiveFailed: passive.filter((x) => !x.ok).length, saveOverlap: stats(saveOverlap), commitOverlap: stats(commitOverlap) } : {})
        })
        slow.forEach((s) => log('HW6SLOW', { scenario: scen, group: g, ...s }))
        await db.closeAsync()
        expect(save).toHaveLength(n)
      })
    }
  }
})
