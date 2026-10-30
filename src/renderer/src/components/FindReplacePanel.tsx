import type { Editor } from '@tiptap/react'
import { closeHistory } from '@tiptap/pm/history'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FIND_DEBOUNCE_MS, applyReplacements, findCountLabel, findMatches, matchIndexAtOrAfter, type FindResult } from '../services/find-replace'
import { clearFindHighlights, revealPos, setFindHighlights } from '../services/find-highlight'

const EMPTY: FindResult = { matches: [], truncated: false }

/**
 * 章内查找/替换（Ctrl+F / Ctrl+H）。纯本地，无网络、无 AI；小黑屋里同样可用。
 * 所有修改都走编辑器事务（closeHistory 让每次替换自成一步撤销），保存沿用 onUpdate → SaveCoordinator。
 */
export function FindReplacePanel({ editor, mode, focusToken, scroller, onMode, onClose }: {
  editor: Editor; mode: 'find' | 'replace'; focusToken: number; scroller(): HTMLElement | null
  onMode(mode: 'find' | 'replace'): void; onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [result, setResult] = useState<FindResult>(EMPTY)
  const [current, setCurrent] = useState(-1)
  const [docVersion, setDocVersion] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const anchorRef = useRef<number>(editor.state.selection.from)

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [focusToken])

  // 文档变化（含替换、撤销）后去抖重算命中
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }): void => { if (transaction.docChanged) setDocVersion((value) => value + 1) }
    editor.on('transaction', onTransaction)
    return () => { editor.off('transaction', onTransaction) }
  }, [editor])

  useEffect(() => {
    if (!query) { setResult(EMPTY); setCurrent(-1); return }
    const timer = setTimeout(() => {
      if (editor.isDestroyed) return
      const next = findMatches(editor.state.doc, query, { caseSensitive, regex })
      setResult(next)
      setCurrent(next.matches.length ? matchIndexAtOrAfter(next.matches, anchorRef.current) : -1)
    }, FIND_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [editor, query, caseSensitive, regex, docVersion])

  // 高亮：命中或当前项变了就重建；悬停/分块等装饰重绘 DOM 后也重建（rAF 合并）
  useEffect(() => {
    if (editor.isDestroyed) return
    setFindHighlights(editor.view, result.matches, current)
    let raf = 0
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }): void => {
      if (transaction.docChanged || raf) return
      raf = requestAnimationFrame(() => { raf = 0; if (!editor.isDestroyed) setFindHighlights(editor.view, result.matches, current) })
    }
    editor.on('transaction', onTransaction)
    return () => { editor.off('transaction', onTransaction); if (raf) cancelAnimationFrame(raf) }
  }, [editor, result, current])

  useEffect(() => () => clearFindHighlights(), [])

  const goTo = useCallback((index: number) => {
    const match = result.matches[index]
    if (!match || editor.isDestroyed) return
    setCurrent(index)
    anchorRef.current = match.from
    editor.commands.setTextSelection({ from: match.from, to: match.to })
    void revealPos(editor.view, scroller(), match.from)
  }, [editor, result, scroller])

  const step = (delta: number): void => {
    const count = result.matches.length
    if (!count) return
    goTo(current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count)
  }

  const dispatchReplace = (matches: FindResult['matches']): number => {
    const tr = editor.state.tr
    const count = applyReplacements(tr, matches, replacement, regex)
    if (!count) return 0
    editor.view.dispatch(closeHistory(tr))
    editor.view.dispatch(closeHistory(editor.state.tr)) // 之后的输入另起一步撤销
    return count
  }

  const replaceCurrent = (): void => {
    const match = result.matches[current]
    if (!match) return
    anchorRef.current = match.from
    if (dispatchReplace([match])) {
      // 立即重算，当前项落在替换位置之后的第一处
      const next = findMatches(editor.state.doc, query, { caseSensitive, regex })
      const len = regex ? 0 : replacement.length
      const index = next.matches.length ? matchIndexAtOrAfter(next.matches, match.from + len) : -1
      setResult(next); setCurrent(index)
      if (index >= 0) { anchorRef.current = next.matches[index].from; void revealPos(editor.view, scroller(), next.matches[index].from) }
    }
  }
  const [notice, setNotice] = useState('')
  const replaceAll = (): void => {
    if (!result.matches.length) return
    const count = dispatchReplace(result.matches)
    setNotice(count ? `已替换 ${count} 处（Ctrl+Z 可一次撤销）` : '')
  }
  useEffect(() => { setNotice('') }, [query, replacement, caseSensitive, regex])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (event.key === 'Enter' && event.currentTarget === inputRef.current) { event.preventDefault(); step(event.shiftKey ? -1 : 1) }
  }

  return <div className="find-panel" role="search" aria-label="章内查找替换" data-testid="find-panel" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <div className="find-row">
      <input ref={inputRef} aria-label="查找" placeholder="查找" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} />
      <span className="find-count" data-testid="find-count" aria-live="polite">{query && !result.error ? findCountLabel(current, result.matches.length, result.truncated) : ''}</span>
      <button className="icon-button" title="上一处（Shift+Enter）" aria-label="上一处" onClick={() => step(-1)} disabled={!result.matches.length}><ChevronUp size={15} /></button>
      <button className="icon-button" title="下一处（Enter）" aria-label="下一处" onClick={() => step(1)} disabled={!result.matches.length}><ChevronDown size={15} /></button>
      <button className="icon-button" title="关闭（Esc）" aria-label="关闭查找" onClick={onClose}><X size={15} /></button>
    </div>
    {mode === 'replace' ? <div className="find-row">
      <input aria-label="替换为" placeholder="替换为" value={replacement} onChange={(event) => setReplacement(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); replaceCurrent() } }} />
      <button onClick={replaceCurrent} disabled={current < 0}>替换当前</button>
      <button onClick={replaceAll} disabled={!result.matches.length}>全部替换</button>
    </div> : <div className="find-row"><button className="link-button" onClick={() => onMode('replace')}>替换…（Ctrl+H）</button></div>}
    <div className="find-row find-options">
      <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />区分大小写</label>
      <label><input type="checkbox" checked={regex} onChange={(event) => setRegex(event.target.checked)} />正则</label>
    </div>
    {result.error && <p className="find-error" role="alert">{result.error}</p>}
    {notice && <p className="find-notice" role="status" data-testid="find-notice">{notice}</p>}
  </div>
}
