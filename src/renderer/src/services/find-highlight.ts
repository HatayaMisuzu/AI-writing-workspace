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

/** pos 所在的超长段分块（long-paragraph-chunks.ts）元素；不在分块里返回 undefined。 */
const chunkAt = (view: EditorView, pos: number): Element | undefined => {
  try {
    const { node } = view.domAtPos(pos)
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
    return element?.closest('.long-paragraph-chunk') ?? undefined
  } catch { return undefined }
}

/**
 * 把 pos 滚到滚动容器上部 1/3 处：每帧量一次（单次 coordsAtPos），不在可视区就瞬时滚动；
 * 连续两帧都在可视区且位置不变才结束，最多 REVEAL_MAX_PASSES 帧。
 * 分块超长段（long-paragraph-chunks.ts）的屏外块是 content-visibility:auto、内容被跳过渲染：
 * 块内位置的几何（coordsAtPos / Range rect）不可信，会给出「已在可视区」的假象（PR45 CI 实测光标停在可视区下方 ~1000px）。
 * 所以目标在分块里且该块不在可视区时，先按块自身的盒子（占位尺寸，可信）把块滚进可视区，等它真正渲染后再按 coordsAtPos 精调。
 * 普通段落、含格式长段第一次滚动就准，只多一次（布局已干净的）coordsAtPos 用于确认。
 * .writing-scroll 设了 scroll-behavior:smooth，所以用 behavior:'instant'。
 */
export const REVEAL_MAX_PASSES = 10
export async function revealPos(view: EditorView, scroller: HTMLElement | null | undefined, pos: number): Promise<void> {
  if (!scroller) return
  let lastTop: number | undefined
  for (let pass = 0; pass < REVEAL_MAX_PASSES; pass += 1) {
    await frame()
    if (view.isDestroyed || pos > view.state.doc.content.size) return
    const box = scroller.getBoundingClientRect()
    const chunk = chunkAt(view, pos)
    if (chunk) {
      const rect = chunk.getBoundingClientRect()
      if (rect.bottom <= box.top || rect.top >= box.bottom) {
        // 块不在可视区：按块盒子滚过去（块顶对齐可视区顶），下一帧它会被渲染
        scroller.scrollTo({ top: scroller.scrollTop + rect.top - box.top, behavior: 'instant' })
        lastTop = undefined
        continue
      }
    }
    const coords = view.coordsAtPos(pos)
    if (coords.top >= box.top && coords.bottom <= box.bottom) {
      if (lastTop !== undefined && Math.abs(coords.top - lastTop) < 1) return
      lastTop = coords.top
      continue
    }
    lastTop = undefined
    scroller.scrollTo({ top: scroller.scrollTop + coords.top - (box.top + box.height / 3), behavior: 'instant' })
  }
}
