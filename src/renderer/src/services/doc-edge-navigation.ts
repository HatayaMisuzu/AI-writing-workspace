/**
 * Ctrl/Cmd+Home、Ctrl/Cmd+End（含 Shift 扩选）由编辑器自己处理，不交给 Chromium 原生光标移动。
 * 只在文档含超长段时接管（普通文档仍走原生，行为不变）。
 * 原因：分块超长段（long-paragraph-chunks.ts：段内 display:block + content-visibility:auto 的块）里，
 * 屏外块按占位估高，滚动目标会随块真正布局而移动；这里统一成一次 ProseMirror 事务设选区 +
 * revealPos（逐帧量一次、瞬时滚动、稳定即停，有帧数上限），与查找跳转同一条路径。
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { LONG_PARAGRAPH_CHARS } from './long-paragraph-chunks'

export type DocEdge = 'start' | 'end'

export interface DocEdgeKey { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

/** 只认 Ctrl/Cmd+Home/End（可带 Shift，不带 Alt）。 */
export const docEdgeOf = (event: DocEdgeKey): DocEdge | undefined => {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return undefined
  return event.key === 'End' ? 'end' : event.key === 'Home' ? 'start' : undefined
}

/** 目标选区：不带 Shift 时折叠到文首/文末；带 Shift 时保留锚点扩选到文首/文末。 */
export const docEdgeSelection = (doc: ProseMirrorNode, current: Selection, edge: DocEdge, extend: boolean): Selection => {
  const target = edge === 'end' ? Selection.atEnd(doc) : Selection.atStart(doc)
  if (!extend) return target
  return TextSelection.between(doc.resolve(current.anchor), target.$head)
}

/** 只在含超长段（> LONG_PARAGRAPH_CHARS）的文档里接管；普通文档保持 Chromium 原生行为不变。 */
export const hasLongParagraph = (doc: ProseMirrorNode): boolean => {
  let found = false
  doc.forEach((block) => { if (!found && block.isTextblock && block.content.size > LONG_PARAGRAPH_CHARS) found = true })
  return found
}

/**
 * 滚动目标：段末光标是「最后一个字之后」的边界位置，DOM 落点在分块之外，几何不可靠；
 * 改用段内最后一个字的位置（与光标同一行）。其余情况就是光标本身。
 */
export const revealTarget = (selection: Selection): number => {
  const $head = selection.$head
  return $head.parent.isTextblock && $head.parentOffset > 0 && $head.parentOffset === $head.parent.content.size ? selection.head - 1 : selection.head
}

export const docEdgeNavigationKey = new PluginKey('docEdgeNavigation')

export function docEdgeNavigationPlugin(options: { reveal(view: EditorView, pos: number): void; enabled?(): boolean }): Plugin {
  return new Plugin({
    key: docEdgeNavigationKey,
    props: {
      handleKeyDown: (view, event) => {
        const edge = docEdgeOf(event)
        if (!edge || (options.enabled && !options.enabled()) || !hasLongParagraph(view.state.doc)) return false
        const selection = docEdgeSelection(view.state.doc, view.state.selection, edge, event.shiftKey)
        view.dispatch(view.state.tr.setSelection(selection))
        options.reveal(view, revealTarget(selection))
        return true
      }
    }
  })
}
