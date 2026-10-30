import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { RotateCcw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentNode } from '../../../shared/domain'
import { FIND_DEBOUNCE_MS } from '../services/find-replace'
import { bookFindSummary, prepareBookReplace, searchBook, type BookFindProgress } from '../services/book-find'
import { Modal } from '../components/Modal'
import type { BookRestoreResult } from '../../../shared/domain'

export interface BookFindTarget { documentId: string; query: string; caseSensitive: boolean; regex: boolean; anchor: number }

const schema = getSchema([StarterKit])
/** 一次只渲染前 GROUP_PAGE 章，避免 1000 章结果一次建出大量节点。 */
const GROUP_PAGE = 200

export interface BookReplaceHooks {
  /** 替换 / 恢复前：保存所有未保存内容（编辑器防抖保存、辅助面板）。 */
  onBeforeReplace(): Promise<void>
  /** 期间禁止切章 / 切区段（打开章不可编辑）。 */
  onBusy(busy: boolean): void
  /** 写库成功后：重新载入打开章（新 revision、空撤销栈）并刷新章节树。 */
  onContentChanged(documentIds: string[]): Promise<void>
  /** 最近一次全书替换（状态放在 WorkspaceScreen，切区段回来仍可「撤销本次全书替换」）。 */
  lastBatch?: BookBatchInfo
  onLastBatch(batch?: BookBatchInfo): void
}
export interface BookBatchInfo { batchId: string; chapters: number; hits: number }

/** 全书查找与替换（P3 PR-2a 查找 / PR-2b 替换）：逐章复用章内查找的匹配和替换规则，结果按章分组；纯本地，无网络、无 AI，小黑屋内可用。 */
export function BookFindView({ projectId, chapters, onOpenHit, onBeforeReplace, onBusy, onContentChanged, lastBatch, onLastBatch }: { projectId: string; chapters: DocumentNode[]; onOpenHit(target: BookFindTarget): void } & BookReplaceHooks): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [progress, setProgress] = useState<BookFindProgress | undefined>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [visible, setVisible] = useState(GROUP_PAGE)
  const [replacement, setReplacement] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'replace' | 'restore' | undefined>()
  const [replaceError, setReplaceError] = useState<string>()
  const [restoreResult, setRestoreResult] = useState<BookRestoreResult>()
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // 目录刷新会给出新的 chapters 数组；只有 id / 标题真的变了才重搜（否则保存后刷新目录会把已完成的结果冲掉）
  const refsKey = chapters.map((node) => `${node.id}\u0000${node.title}`).join('\u0001')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const refs = useMemo(() => chapters.map((node) => ({ id: node.id, title: node.title })), [refsKey])
  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const mine = ++generation.current
    // 条件一变就清掉旧结果，避免去抖期间显示/点击旧查询的命中
    setProgress(undefined)
    if (!query) return
    const timer = setTimeout(() => {
      void searchBook({ chapters: refs, schema, query, options: { caseSensitive, regex },
        load: async (ids) => (await Promise.all(ids.map((id) => window.workspace.documents.get(projectId, id)))).map((content) => content.editorJson),
        onProgress: (next) => { if (generation.current === mine) setProgress(next) },
        isCancelled: () => generation.current !== mine
      }).catch((error) => { if (generation.current === mine) setProgress({ groups: [], scanned: 0, total: refs.length, hits: 0, truncated: false, done: true, error: error instanceof Error ? error.message : String(error) }) })
    }, FIND_DEBOUNCE_MS)
    return () => { clearTimeout(timer); generation.current += 1 }
  }, [projectId, refs, query, caseSensitive, regex, refresh])
  useEffect(() => { setExpanded(new Set()); setVisible(GROUP_PAGE); setExcluded(new Set()) }, [query, caseSensitive, regex])

  const selectedGroups = progress?.groups.filter((group) => !excluded.has(group.documentId)) ?? []
  const selectedHits = selectedGroups.reduce((sum, group) => sum + group.count, 0)
  const canReplace = !!progress?.done && !progress.error && !progress.truncated && selectedGroups.length > 0 && !busy
  const titleOf = (id: string): string => chapters.find((node) => node.id === id)?.title ?? id

  const runBusy = async (kind: 'replace' | 'restore', task: () => Promise<void>): Promise<void> => {
    setBusy(kind); onBusy(true); setReplaceError(undefined)
    try { await onBeforeReplace(); await task() }
    finally { setBusy(undefined); onBusy(false) }
  }
  const replaceAll = (): Promise<void> => runBusy('replace', async () => {
    const ids = selectedGroups.map((group) => group.documentId)
    try {
      // 按库里最新内容重新计算（已 flush），不用搜索时的旧结果；提交时逐章带 expectedRevision
      const t0 = performance.now()
      const plan = await prepareBookReplace({ chapterIds: ids, schema, query, replacement, options: { caseSensitive, regex },
        load: (batchIds) => Promise.all(batchIds.map((id) => window.workspace.documents.get(projectId, id))) })
      if (plan.error) { setReplaceError(plan.error); return }
      if (plan.truncated) { setReplaceError('命中超过 100,000 处，未替换任何章节：请缩小查找范围'); return }
      if (!plan.items.length) { setReplaceError('没有可替换的内容（章节可能已变化），请重新查找'); return }
      const t1 = performance.now()
      const result = await window.workspace.documents.replaceBatch({ projectId, items: plan.items, query, replacement, regex, caseSensitive })
      const t2 = performance.now()
      // 分阶段耗时（e2e 读取；无网络、无副作用）
      const timingTarget = window as unknown as { __bookReplaceTiming?: Record<string, number> }
      timingTarget.__bookReplaceTiming = { prepareMs: Math.round(t1 - t0), ipcMs: Math.round(t2 - t1), chapters: plan.items.length, ...result.timing }
      onLastBatch({ batchId: result.batchId, chapters: result.chapters, hits: result.hits })
      await onContentChanged(result.contents.map((item) => item.documentId)).catch((error: unknown) => setReplaceError(`已替换，但刷新当前章失败：${error instanceof Error ? error.message : String(error)}`))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setReplaceError(message.includes('REVISION_CONFLICT') ? '有章节已变化，本次没有写入任何章节，请重新查找' : `替换失败，本次没有写入任何章节：${message}`)
    } finally { setRefresh((value) => value + 1) }
  })
  const restoreBatch = (batchId: string): Promise<void> => runBusy('restore', async () => {
    try {
      const result = await window.workspace.snapshots.restoreBatch(projectId, batchId)
      const timingTarget = window as unknown as { __bookRestoreTiming?: Record<string, number> }
      timingTarget.__bookRestoreTiming = { ...result.timing }
      setRestoreResult(result); onLastBatch(undefined)
      if (result.restored.length) await onContentChanged(result.restored.map((item) => item.documentId)).catch((error: unknown) => setReplaceError(`已恢复，但刷新当前章失败：${error instanceof Error ? error.message : String(error)}`))
    } catch (error) { setReplaceError(`恢复失败，本次没有恢复任何章节：${error instanceof Error ? error.message : String(error)}`) }
    finally { setRefresh((value) => value + 1) }
  })

  const open = (documentId: string, anchor: number): void => onOpenHit({ documentId, query, caseSensitive, regex, anchor })

  return <section className="project-view book-find" aria-label="全书查找" data-testid="book-find">
    <header><div><h1>全书查找</h1><p>按章节列出命中，点击跳到该处；可按章取消勾选后全部替换。纯本地，不联网、不用 AI；全书替换不计入码字。</p></div></header>
    <div className="book-find-bar" role="search">
      <Search size={16} />
      <input ref={inputRef} aria-label="全书查找" placeholder="在全书中查找" value={query} onChange={(event) => setQuery(event.target.value)} />
      <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />区分大小写</label>
      <label><input type="checkbox" checked={regex} onChange={(event) => setRegex(event.target.checked)} />正则</label>
    </div>
    <div className="book-find-bar book-replace-bar">
      <input aria-label="全书替换为" placeholder={regex ? '替换为（可用 $1）' : '替换为'} value={replacement} disabled={!!busy} onChange={(event) => setReplacement(event.target.value)} />
      <button className="primary" disabled={!canReplace} onClick={() => setConfirming(true)} data-testid="book-replace-all">{busy === 'replace' ? '全书替换中…' : `替换 ${selectedHits.toLocaleString()} 处 / ${selectedGroups.length} 章`}</button>
    </div>
    {progress?.truncated && <p className="find-error" data-testid="book-replace-disabled">结果已截断，不能全书替换：请缩小查找范围</p>}
    {replaceError && <p className="find-error" role="alert" data-testid="book-replace-error">{replaceError}</p>}
    {lastBatch && <p className="book-replace-done" role="status" data-testid="book-replace-done">已替换 {lastBatch.chapters} 章 {lastBatch.hits.toLocaleString()} 处 · <button className="link-button" data-testid="book-restore" disabled={!!busy} onClick={() => void restoreBatch(lastBatch.batchId)}><RotateCcw size={14} />{busy === 'restore' ? '恢复中…' : '撤销本次全书替换'}</button></p>}
    {progress && <p className={progress.error ? 'find-error' : progress.truncated ? 'book-find-summary truncated' : 'book-find-summary'} role={progress.error || progress.truncated ? 'alert' : 'status'} data-testid="book-find-summary" data-done={progress.done ? 'true' : 'false'}>{bookFindSummary(progress)}</p>}
    <ol className="book-find-groups">{progress?.groups.slice(0, visible).map((group) => <li key={group.documentId} className="book-find-group" data-testid="book-find-group">
      <input type="checkbox" className="book-find-check" aria-label={`替换 ${group.title}`} checked={!excluded.has(group.documentId)} disabled={!!busy} onChange={(event) => setExcluded((prev) => { const next = new Set(prev); if (event.target.checked) next.delete(group.documentId); else next.add(group.documentId); return next })} />
      <button className="book-find-title" onClick={() => setExpanded((prev) => { const next = new Set(prev); if (next.has(group.documentId)) next.delete(group.documentId); else next.add(group.documentId); return next })}>
        <strong>{group.title}</strong><span>{group.count.toLocaleString()} 处</span>
      </button>
      <ul>{(expanded.has(group.documentId) ? group.excerpts : group.excerpts.slice(0, 1)).map((excerpt) => <li key={excerpt.from}>
        <button className="book-find-hit" onClick={() => open(group.documentId, excerpt.from)}>{excerpt.before}<mark>{excerpt.text}</mark>{excerpt.after}</button>
      </li>)}</ul>
      {group.count > 1 && !expanded.has(group.documentId) && <button className="link-button" onClick={() => setExpanded((prev) => new Set(prev).add(group.documentId))}>展开本章摘要</button>}
    </li>)}</ol>
    {progress && progress.groups.length > visible && <button onClick={() => setVisible((value) => value + GROUP_PAGE)}>显示更多章节（还有 {progress.groups.length - visible} 章）</button>}
    {confirming && <Modal title="全书替换" onClose={() => setConfirming(false)}>
      <p>将把「{query}」替换为「{replacement}」：{selectedGroups.length} 章，共 {selectedHits.toLocaleString()} 处（按库中最新内容重新计算）。</p>
      <p>替换前会给每章拍快照，可在这里或历史页「全书替换前」整批恢复。当前章的撤销记录会清空，可用快照整批恢复。全书替换不计入码字和小黑屋目标。</p>
      <div className="modal-actions"><button onClick={() => setConfirming(false)}>取消</button><button className="primary" data-testid="book-replace-confirm" onClick={() => { setConfirming(false); void replaceAll() }}>确认替换</button></div>
    </Modal>}
    {restoreResult && <Modal title="整批恢复结果" onClose={() => setRestoreResult(undefined)}>
      <p data-testid="book-restore-summary">已恢复 {restoreResult.restored.length} 章。</p>
      {restoreResult.skipped.length > 0 && <div data-testid="book-restore-skipped"><p>以下 {restoreResult.skipped.length} 章没有恢复：替换后又改过（或已删除），保留当前内容。可在历史页单独恢复。</p>
        <ul>{restoreResult.skipped.map((item) => <li key={item.documentId}>{item.title || titleOf(item.documentId)}{item.reason === 'deleted' ? '（已删除）' : '（之后又改过）'}</li>)}</ul></div>}
      <div className="modal-actions"><button className="primary" onClick={() => setRestoreResult(undefined)}>知道了</button></div>
    </Modal>}
  </section>
}
