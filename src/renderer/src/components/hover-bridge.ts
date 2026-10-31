import type { EditorView } from '@tiptap/pm/view'

/**
 * F14 B+：悬停卡与其命中之间的空带（卡定位在命中 rect 外 6px，鼠标慢慢移向卡片必经此带）。
 * 纵向：两 rect 之间的空带（卡在下：命中底→卡顶；卡翻到命中上方：卡底→命中顶）；横向：命中与卡片左右边界的并集。
 * 命中节点按当前卡的 pmFrom 实时从视图取；取不到或已断开就不算允许区（照常关）。两 rect 重叠时没有空带，也不算。
 */
export function isInHoverBridge(view: EditorView, hit: { pmFrom: number; pmTo: number } | undefined, x: number, y: number): boolean {
  if (!hit || view.isDestroyed) return false
  const cardEl = document.querySelector('.character-hover-card')
  if (!cardEl) return false
  let hitEl: Element | null | undefined
  try {
    const { node } = view.domAtPos(Math.min(hit.pmFrom + 1, hit.pmTo))
    hitEl = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest('.character-hit')
  } catch { return false }
  if (!hitEl?.isConnected) return false
  const h = hitEl.getBoundingClientRect()
  const c = cardEl.getBoundingClientRect()
  let top: number
  let bottom: number
  if (c.top >= h.bottom) { top = h.bottom; bottom = c.top } else if (c.bottom <= h.top) { top = c.bottom; bottom = h.top } else return false
  const left = Math.min(h.left, c.left)
  const right = Math.max(h.right, c.right)
  return x >= left && x <= right && y >= top && y <= bottom
}
