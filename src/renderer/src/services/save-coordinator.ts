import type { DocumentContent, TextOrigin } from '../../../shared/domain'

export interface EditorSnapshot {
  editorJson: Record<string, unknown>
  plainText: string
  baseRevision: number
  styleSample?: { origin: TextOrigin; text: string }
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
    private readonly delayMs = 700
  ) { this.revision = initialRevision }

  markDirty(snapshot: Omit<EditorSnapshot, 'baseRevision'> & { baseRevision?: number }): void {
    this.pending = { ...snapshot, styleSample: snapshot.styleSample ?? this.pending?.styleSample,
      baseRevision: snapshot.baseRevision ?? this.revision }
    this.onState('dirty')
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush().catch(() => undefined) }, this.delayMs)
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (!this.drain) this.drain = this.drainPending().finally(() => { this.drain = undefined })
    return this.drain
  }

  private async drainPending(): Promise<void> {
    while (this.pending) {
      const snapshot = { ...this.pending, baseRevision: this.revision }
      this.pending = undefined
      this.onState('saving')
      await this.save(snapshot).then((saved) => {
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
  resetRevision(revision: number): void { if (!this.hasPending()) this.revision = revision }
  dispose(): void { if (this.timer) clearTimeout(this.timer) }
}

const onPendingRevision = (pending: EditorSnapshot | undefined, revision: number): void => {
  if (pending) pending.baseRevision = revision
}
