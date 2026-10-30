import type { DocumentContent, TextOrigin } from '../../../shared/domain'

export interface EditorSnapshot {
  editorJson: Record<string, unknown>
  plainText: string
  baseRevision: number
  styleSample?: { origin: TextOrigin; text: string }
}

/**
 * 自动保存节奏：停止输入 700ms 后保存；连续输入时距本轮第一次改动最迟 2000ms 也会保存。
 * 崩溃/强杀时最多丢失「最近 SAVE_MAX_WAIT_MS 内的输入 + 一次进行中的保存」。
 * 切章、关窗、退出、进小黑屋、备份等路径都会先 flush()，不受这个上限影响。
 */
export const SAVE_IDLE_DELAY_MS = 700
export const SAVE_MAX_WAIT_MS = 2000

// DIAG（诊断分支）：保存节奏打点，墙钟 ms（performance.timeOrigin + now），最多 500 条；只记录，不影响行为
const diagNow = (): number => Math.round((performance.timeOrigin + performance.now()) * 10) / 10
const diagMark = (event: string, data: Record<string, unknown> = {}): void => {
  const g = globalThis as unknown as { __inkstoneSaveDiag?: Array<Record<string, unknown>> }
  const list = (g.__inkstoneSaveDiag ??= [])
  list.push({ t: diagNow(), event, ...data })
  if (list.length > 500) list.splice(0, list.length - 500)
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

export class SaveCoordinator {
  private pending?: EditorSnapshot
  private timer?: ReturnType<typeof setTimeout>
  private drain?: Promise<void>
  private revision: number

  constructor(
    initialRevision: number,
    private readonly save: (snapshot: EditorSnapshot) => Promise<DocumentContent>,
    private readonly onSaved: (content: DocumentContent) => void,
    private readonly onState: (state: SaveState, error?: unknown) => void,
    private readonly delayMs = SAVE_IDLE_DELAY_MS,
    private readonly maxWaitMs = SAVE_MAX_WAIT_MS
  ) { this.revision = initialRevision }
  /** 本轮未保存改动的开始时间：连续输入时也保证最迟 maxWaitMs 后落盘（防抖不会无限推迟）。 */
  private dirtySince?: number

  markDirty(snapshot: Omit<EditorSnapshot, 'baseRevision'> & { baseRevision?: number }): void {
    this.pending = { ...snapshot, styleSample: snapshot.styleSample ?? this.pending?.styleSample,
      baseRevision: snapshot.baseRevision ?? this.revision }
    this.onState('dirty')
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const now = Date.now()
    this.dirtySince ??= now
    const wait = Math.max(0, Math.min(this.delayMs, this.dirtySince + this.maxWaitMs - now))
    diagMark('r:schedule', { wait })
    this.timer = setTimeout(() => { diagMark('r:timer-fire'); void this.flush().catch(() => undefined) }, wait)
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    this.dirtySince = undefined
    if (!this.drain) this.drain = this.drainPending().finally(() => { this.drain = undefined })
    return this.drain
  }

  private async drainPending(): Promise<void> {
    while (this.pending) {
      const snapshot = { ...this.pending, baseRevision: this.revision }
      this.pending = undefined
      this.onState('saving')
      diagMark('r:ipc-send', { baseRevision: snapshot.baseRevision })
      await this.save(snapshot).then((saved) => {
        diagMark('r:ipc-recv', { revision: saved.revision })
        this.revision = saved.revision
        onPendingRevision(this.pending, saved.revision)
        this.onSaved(saved)
      }).catch((error) => {
        if (!this.pending) this.pending = snapshot
        this.onState('error', error)
        throw error
      })
    }
    this.onState('saved')
  }

  hasPending(): boolean { return Boolean(this.pending || this.drain) }
  currentRevision(): number { return this.revision }
  resetRevision(revision: number): void {
    if (this.drain) return
    this.revision = revision
    if (this.pending) this.pending.baseRevision = revision
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer) }
}

const onPendingRevision = (pending: EditorSnapshot | undefined, revision: number): void => {
  if (pending) pending.baseRevision = revision
}
