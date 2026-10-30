import type { Editor } from '@tiptap/react'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { chapterHeadings, type ChapterHeading } from '../services/chapter-headings'
import { revealPos } from '../services/find-highlight'

/** 本章大纲：章内标题与场景分隔，点击跳转并放置光标。文档变化后 300ms 去抖重扫（O(块数)）。 */
export function ChapterHeadingsPanel({ editor, scroller, onClose }: { editor: Editor; scroller(): HTMLElement | null; onClose(): void }) {
  const [items, setItems] = useState<ChapterHeading[]>(() => chapterHeadings(editor.state.doc))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }): void => {
      if (!transaction.docChanged) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (!editor.isDestroyed) setItems(chapterHeadings(editor.state.doc)) }, 300)
    }
    editor.on('transaction', onTransaction)
    return () => { editor.off('transaction', onTransaction); if (timer) clearTimeout(timer) }
  }, [editor])
  const jump = (item: ChapterHeading): void => {
    if (editor.isDestroyed) return
    const pos = Math.min(item.pos, editor.state.doc.content.size)
    editor.chain().setTextSelection(pos).focus(undefined, { scrollIntoView: false }).run()
    void revealPos(editor.view, scroller(), pos)
  }
  return <aside className="chapter-headings" aria-label="本章大纲" data-testid="chapter-headings" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header><h3>本章大纲</h3><button className="icon-button" aria-label="关闭本章大纲" onClick={onClose}><X size={15} /></button></header>
    {items.length === 0 ? <p className="empty-copy">本章没有标题或场景分隔（单独成段的 ***、——、◇ 等）。</p>
      : <ol>{items.map((item, index) => <li key={`${item.pos}-${index}`} className={`heading-item ${item.kind} level-${item.level}`}>
        <button onClick={() => jump(item)} data-pos={item.pos}><strong>{item.kind === 'scene' ? `场景 ${item.label}` : item.label}</strong>{item.preview && <small>{item.preview}</small>}</button>
      </li>)}</ol>}
  </aside>
}
