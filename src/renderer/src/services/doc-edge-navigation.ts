/**
 * Ctrl/Cmd+Home、Ctrl/Cmd+End（含 Shift 扩选）由编辑器自己处理，不交给 Chromium 原生光标移动。
 * 原因：分块超长段（long-paragraph-chunks.ts：段内 display:block + content-visibility:auto 的块）里，
 * 屏外块按占位估高，滚动目标会随块真正布局而移动；这里统一成一次 ProseMirror 事务设选区 +
 * revealPos（逐帧量一次、瞬时滚动、稳定即停，有帧数上限），与查找跳转同一条路径。
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

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

export const docEdgeNavigationKey = new PluginKey('docEdgeNavigation')

export function docEdgeNavigationPlugin(options: { reveal(view: EditorView, pos: number): void; enabled?(): boolean }): Plugin {
  return new Plugin({
    key: docEdgeNavigationKey,
    props: {
      handleKeyDown: (view, event) => {
        const edge = docEdgeOf(event)
        if (!edge || (options.enabled && !options.enabled())) return false
        const selection = docEdgeSelection(view.state.doc, view.state.selection, edge, event.shiftKey)
        view.dispatch(view.state.tr.setSelection(selection))
        options.reveal(view, selection.head)
        return true
      }
    }
  })
}
