import { useState } from 'react'
import type { DocumentNode, FocusLockCombine, FocusLockInput, FocusLockMode, FocusLockStatus } from '../../../shared/domain'
import { Modal } from './Modal'

const EXIT_PHRASE = '我要出屋'
const cleanError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const formatRemaining = (ms: number): string => {
  const total = Math.ceil(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** 进入小黑屋：每次由作者填写，不预填任何值；超限由主进程拒绝，不自动修正。 */
export function BlackroomEntryDialog({ onClose, onStart }: { onClose(): void; onStart(input: FocusLockInput): Promise<void> }): React.JSX.Element {
  const [mode, setMode] = useState<FocusLockMode>()
  const [words, setWords] = useState('')
  const [minutes, setMinutes] = useState('')
  const [combine, setCombine] = useState<FocusLockCombine>()
  const [error, setError] = useState<string>()
  const num = (value: string): number => (value.trim() === '' ? Number.NaN : Number(value.trim()))
  const submit = async (): Promise<void> => {
    if (!mode) { setError('请选择锁定方式。'); return }
    const input: FocusLockInput = { mode, ...(mode !== 'minutes' ? { words: num(words) } : {}), ...(mode !== 'words' ? { minutes: num(minutes) } : {}), ...(mode === 'combo' && combine ? { combine } : {}) }
    try { await onStart(input) } catch (failure) { setError(cleanError(failure)) }
  }
  return <Modal title="进入小黑屋" onClose={onClose}><form className="node-create-form blackroom-entry" data-testid="blackroom-entry" onSubmit={(event) => { event.preventDefault(); void submit() }}>
    <p className="isolation-note">锁定期间只保留写作：AI、检索、设置、导出与其它作品都会关闭。条件达成后点「出屋」离开；Esc 不会退出。</p>
    <fieldset className="blackroom-modes"><legend>锁定方式</legend>
      <label><input type="radio" name="blackroom-mode" checked={mode === 'words'} onChange={() => setMode('words')} />写满字数</label>
      <label><input type="radio" name="blackroom-mode" checked={mode === 'minutes'} onChange={() => setMode('minutes')} />写满时间</label>
      <label><input type="radio" name="blackroom-mode" checked={mode === 'combo'} onChange={() => setMode('combo')} />组合</label>
    </fieldset>
    {mode && mode !== 'minutes' && <label><span>目标字数（1–50000）</span><input aria-label="目标字数" inputMode="numeric" value={words} onChange={(event) => setWords(event.target.value)} /></label>}
    {mode && mode !== 'words' && <label><span>时间（1–600 分钟）</span><input aria-label="分钟数" inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value)} /></label>}
    {mode === 'combo' && <fieldset className="blackroom-modes"><legend>满足方式</legend>
      <label><input type="radio" name="blackroom-combine" checked={combine === 'all'} onChange={() => setCombine('all')} />都满足</label>
      <label><input type="radio" name="blackroom-combine" checked={combine === 'any'} onChange={() => setCombine('any')} />任一满足</label>
    </fieldset>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit">锁定并开始</button></div>
  </form></Modal>
}

/** 顶部细条：进度 / 剩余时间、章节下拉（无侧栏，D3）、达成后的「出屋」、紧急出口。 */
export function BlackroomBar({ status, chapters, selectedId, onSelectChapter, onFinish, onEmergency }: {
  status: FocusLockStatus; chapters: DocumentNode[]; selectedId?: string
  onSelectChapter(node: DocumentNode): void; onFinish(): void; onEmergency(): void
}): React.JSX.Element {
  const lock = status.lock!
  return <div className="blackroom-bar" data-testid="blackroom-bar">
    <strong>小黑屋</strong>
    {lock.words !== undefined && <span data-testid="blackroom-words">已写 {status.progressWords.toLocaleString()} / {lock.words.toLocaleString()} 字</span>}
    {status.remainingMs !== undefined && <span data-testid="blackroom-remaining">剩余 {formatRemaining(status.remainingMs)}</span>}
    {lock.mode === 'combo' && <span>{lock.combine === 'all' ? '都满足' : '任一满足'}</span>}
    <select aria-label="切换章节" value={selectedId ?? ''} onChange={(event) => { const node = chapters.find((item) => item.id === event.target.value); if (node) onSelectChapter(node) }}>
      {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
    </select>
    <span />
    {status.reached && <button className="primary" data-testid="blackroom-finish" onClick={onFinish}>出屋</button>}
    <button className="blackroom-emergency" onClick={onEmergency}>紧急出口</button>
  </div>
}

export function BlackroomEmergencyDialog({ onClose, onConfirm }: { onClose(): void; onConfirm(phrase: string): Promise<void> }): React.JSX.Element {
  const [phrase, setPhrase] = useState('')
  const [error, setError] = useState<string>()
  return <Modal title="紧急出屋" onClose={onClose}><form className="node-create-form" onSubmit={(event) => { event.preventDefault(); void onConfirm(phrase).catch((failure) => setError(cleanError(failure))) }}>
    <label><span>输入「{EXIT_PHRASE}」确认离开（会先保存正文）</span><input aria-label="紧急出屋确认" autoFocus value={phrase} onChange={(event) => setPhrase(event.target.value)} /></label>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="danger-button" type="submit" disabled={phrase.trim() !== EXIT_PHRASE}>确认出屋</button></div>
  </form></Modal>
}
