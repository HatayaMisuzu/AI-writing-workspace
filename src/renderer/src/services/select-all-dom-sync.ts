import type { EditorView } from '@tiptap/pm/view'

/**
 * U03：全选（Mod-a）之后，把当前非空的 ProseMirror 选区强制写回 DOM。
 * 场景：state 已是全选，鼠标点击把 DOM 选区折叠但 PM 还没读到；此时再全选，事务选区与原选区相同，
 * view 认为选区没变就不写 DOM，随后 DOMObserver 读到折叠的 DOM 选区把 state 也折叠。
 * 这里不记任何旧选区，只按「当前」PM 选区写 DOM；DOM 已一致时不动。
 */
export function syncSelectionToDom(view: EditorView): void {
  const { from, to } = view.state.selection
  if (from === to) return
  const root = view.dom.ownerDocument
  const domSelection = root.getSelection()
  if (!domSelection) return
  const start = view.domAtPos(from)
  const end = view.domAtPos(to)
  const same = domSelection.rangeCount > 0 && !domSelection.isCollapsed
    && domSelection.anchorNode === start.node && domSelection.anchorOffset === start.offset
    && domSelection.focusNode === end.node && domSelection.focusOffset === end.offset
  if (same) return
  domSelection.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
}
