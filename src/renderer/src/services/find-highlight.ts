/**
 * 查找高亮用 CSS Custom Highlight API（不改 DOM、不加 Decoration）：
 * 超长单段是用 inline Decoration 分块显示的（long-paragraph-chunks.ts），再加 inline Decoration 会把块拆碎、
 * 也会触发巨段重排；Highlight 只影响绘制，屏外（content-visibility 跳过的）块里的 Range 也照样有效。
 */
import type { EditorView } from '@tiptap/pm/view'
import type { FindMatch } from './find-replace'

export const FIND_HIGHLIGHT = 'find-hit'
export const FIND_CURRENT_HIGHLIGHT = 'find-current'

type HighlightRegistryLike = { set(name: string, value: unknown): void; delete(name: string): void }
const registry = (): HighlightRegistryLike | undefined => (typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: HighlightRegistryLike }).highlights : undefined)
const HighlightCtor = (): (new (...ranges: Range[]) => unknown) | undefined => (typeof Highlight !== 'undefined' ? Highlight : undefined)

export const findHighlightSupported = (): boolean => Boolean(registry() && HighlightCtor())

const toRange = (view: EditorView, match: Pick<FindMatch, 'from' | 'to'>): Range | undefined => {
  try {
    const start = view.domAtPos(match.from, 1); const end = view.domAtPos(match.to, -1)
    const range = document.createRange()
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset)
    return range
  } catch { return undefined }
}

export function setFindHighlights(view: EditorView, matches: FindMatch[], current: number): void {
  const reg = registry(); const Ctor = HighlightCtor()
  if (!reg || !Ctor || view.isDestroyed) return
  const ranges: Range[] = []
  for (let index = 0; index < matches.length; index += 1) {
    if (index === current) continue
    const range = toRange(view, matches[index]); if (range) ranges.push(range)
  }
  reg.set(FIND_HIGHLIGHT, new Ctor(...ranges))
  const currentRange = current >= 0 && matches[current] ? toRange(view, matches[current]) : undefined
  if (currentRange) reg.set(FIND_CURRENT_HIGHLIGHT, new Ctor(currentRange)); else reg.delete(FIND_CURRENT_HIGHLIGHT)
}

export function clearFindHighlights(): void {
  const reg = registry(); if (!reg) return
  reg.delete(FIND_HIGHLIGHT); reg.delete(FIND_CURRENT_HIGHLIGHT)
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/**
 * 把 pos 滚到滚动容器上部 1/3 处。content-visibility:auto 的块进入视口后才按真实高度布局，
 * 估算高度偏小时一次滚动会落在目标之前，所以逐帧校正，直到目标在可视区且位置不再变化（最多 REVEAL_MAX_FRAMES 帧）。
 */
export const REVEAL_MAX_FRAMES = 24
export async function revealPos(view: EditorView, scroller: HTMLElement | null | undefined, pos: number): Promise<void> {
  if (!scroller) return
  let lastTop = Number.NaN
  for (let attempt = 0; attempt < REVEAL_MAX_FRAMES; attempt += 1) {
    if (view.isDestroyed) return
    const coords = view.coordsAtPos(pos)
    const box = scroller.getBoundingClientRect()
    const visible = coords.top >= box.top && coords.bottom <= box.bottom
    if (visible && Math.abs(coords.top - lastTop) < 1) return
    lastTop = coords.top
    // .writing-scroll 设了 scroll-behavior:smooth；逐帧校正必须用 instant，否则会叠加在未完成的平滑动画上
    if (!visible) scroller.scrollTo({ top: scroller.scrollTop + coords.top - (box.top + box.height / 3), behavior: 'instant' })
    await frame()
  }
}
