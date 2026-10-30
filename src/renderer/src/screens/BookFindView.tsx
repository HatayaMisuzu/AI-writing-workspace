import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentNode } from '../../../shared/domain'
import { FIND_DEBOUNCE_MS } from '../services/find-replace'
import { bookFindSummary, searchBook, type BookFindProgress } from '../services/book-find'

export interface BookFindTarget { documentId: string; query: string; caseSensitive: boolean; regex: boolean; anchor: number }

const schema = getSchema([StarterKit])
/** 一次只渲染前 GROUP_PAGE 章，避免 1000 章结果一次建出大量节点。 */
const GROUP_PAGE = 200

/** 全书查找（P3 PR-2a）：只查找、不替换。逐章复用章内查找的匹配规则，结果按章分组；纯本地，无网络、无 AI，小黑屋内可用。 */
export function BookFindView({ projectId, chapters, onOpenHit }: { projectId: string; chapters: DocumentNode[]; onOpenHit(target: BookFindTarget): void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [progress, setProgress] = useState<BookFindProgress | undefined>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [visible, setVisible] = useState(GROUP_PAGE)
  const generation = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const refs = useMemo(() => chapters.map((node) => ({ id: node.id, title: node.title })), [chapters])
  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const mine = ++generation.current
    if (!query) { setProgress(undefined); return }
    const timer = setTimeout(() => {
      void searchBook({ chapters: refs, schema, query, options: { caseSensitive, regex },
        load: async (ids) => (await Promise.all(ids.map((id) => window.workspace.documents.get(projectId, id)))).map((content) => content.editorJson),
        onProgress: (next) => { if (generation.current === mine) setProgress(next) },
        isCancelled: () => generation.current !== mine
      }).catch((error) => { if (generation.current === mine) setProgress({ groups: [], scanned: 0, total: refs.length, hits: 0, truncated: false, done: true, error: error instanceof Error ? error.message : String(error) }) })
    }, FIND_DEBOUNCE_MS)
    return () => { clearTimeout(timer); generation.current += 1 }
  }, [projectId, refs, query, caseSensitive, regex])
  useEffect(() => { setExpanded(new Set()); setVisible(GROUP_PAGE) }, [query, caseSensitive, regex])

  const open = (documentId: string, anchor: number): void => onOpenHit({ documentId, query, caseSensitive, regex, anchor })

  return <section className="project-view book-find" aria-label="全书查找" data-testid="book-find">
    <header><div><h1>全书查找</h1><p>按章节列出命中，点击跳到该处。这一版只查找，不替换；纯本地，不联网、不用 AI。</p></div></header>
    <div className="book-find-bar" role="search">
      <Search size={16} />
      <input ref={inputRef} aria-label="全书查找" placeholder="在全书中查找" value={query} onChange={(event) => setQuery(event.target.value)} />
      <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />区分大小写</label>
      <label><input type="checkbox" checked={regex} onChange={(event) => setRegex(event.target.checked)} />正则</label>
    </div>
    {progress && <p className={progress.error ? 'find-error' : progress.truncated ? 'book-find-summary truncated' : 'book-find-summary'} role={progress.error || progress.truncated ? 'alert' : 'status'} data-testid="book-find-summary" data-done={progress.done ? 'true' : 'false'}>{bookFindSummary(progress)}</p>}
    <ol className="book-find-groups">{progress?.groups.slice(0, visible).map((group) => <li key={group.documentId} className="book-find-group" data-testid="book-find-group">
      <button className="book-find-title" onClick={() => setExpanded((prev) => { const next = new Set(prev); if (next.has(group.documentId)) next.delete(group.documentId); else next.add(group.documentId); return next })}>
        <strong>{group.title}</strong><span>{group.count.toLocaleString()} 处</span>
      </button>
      <ul>{(expanded.has(group.documentId) ? group.excerpts : group.excerpts.slice(0, 1)).map((excerpt) => <li key={excerpt.from}>
        <button className="book-find-hit" onClick={() => open(group.documentId, excerpt.from)}>{excerpt.before}<mark>{excerpt.text}</mark>{excerpt.after}</button>
      </li>)}</ul>
      {group.count > 1 && !expanded.has(group.documentId) && <button className="link-button" onClick={() => setExpanded((prev) => new Set(prev).add(group.documentId))}>展开本章摘要</button>}
    </li>)}</ol>
    {progress && progress.groups.length > visible && <button onClick={() => setVisible((value) => value + GROUP_PAGE)}>显示更多章节（还有 {progress.groups.length - visible} 章）</button>}
  </section>
}
