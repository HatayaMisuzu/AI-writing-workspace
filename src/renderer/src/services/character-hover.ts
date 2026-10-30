/**
 * F14 人物悬停：ProseMirror 插件（只加 inline Decoration，从不修改文档 / editor_json）。
 * - 全章计算一次；编辑后 500ms 防抖，只重算改动段落 ±1 段。
 * - 章节 > 200000 字或全章匹配 > 50ms：降级为只装饰可见区域上下各 2 屏（degraded = true）。
 * - 「忽略此处」只存在插件状态里（随事务映射位置），不持久化。
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { isChunkedParagraph } from './long-paragraph-chunks'
import { MATCHER_LIMITS, type NameHit, type NameMatcher } from '../../../shared/name-matcher'

export const HOVER_DEBOUNCE_MS = 500
export const HOVER_DEGRADE_NOTICE = '人物悬停：仅可见区域'
export const characterHoverKey = new PluginKey<CharacterHoverState>('characterHover')

export interface HoverRange { from: number; to: number }
export interface CharacterHoverState {
  matcher: NameMatcher | null
  decorations: DecorationSet
  degraded: boolean
  /** 待重算的区间（已映射到当前文档）。 */
  dirty: HoverRange[]
  /** 本次打开期间「忽略此处」的区间。 */
  ignored: HoverRange[]
  viewport?: HoverRange
  lastFullMs?: number
}
export type CharacterHoverMeta =
  | { type: 'setMatcher'; matcher: NameMatcher | null }
  | { type: 'recompute' }
  | { type: 'viewport'; range: HoverRange }
  | { type: 'ignoreAt'; range: HoverRange }

export interface DecoratedHit extends NameHit { /** PM 位置 */ pmFrom: number; pmTo: number }

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** 文本块内容 → 匹配文本：文本原样，非文本叶子节点占 1 位（U+FFFC），长度 = content.size。 */
export const blockMatchText = (block: ProseMirrorNode): string => block.textBetween(0, block.content.size, undefined, '\uFFFC')

/** 在 [from, to] 涉及的所有文本块里找命中，返回 PM 位置。 */
export function hitsInRange(doc: ProseMirrorNode, matcher: NameMatcher, from = 0, to = doc.content.size): DecoratedHit[] {
  const hits: DecoratedHit[] = []
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
    if (!node.isTextblock) return true
    if (isChunkedParagraph(node)) return false // 超长分块段落不加悬停装饰（会把分块拆碎）
    for (const hit of matcher.match(blockMatchText(node))) hits.push({ ...hit, pmFrom: pos + 1 + hit.from, pmTo: pos + 1 + hit.to })
    return false
  })
  return hits
}

const toDecorations = (hits: DecoratedHit[], ignored: HoverRange[]): Decoration[] => hits
  .filter((hit) => !ignored.some((range) => range.from === hit.pmFrom && range.to === hit.pmTo))
  .map((hit) => Decoration.inline(hit.pmFrom, hit.pmTo, {
    class: 'character-hit', 'data-character-ids': hit.characterIds.join(','), 'data-term': hit.term
  }, { hit: { term: hit.term, characterIds: hit.characterIds } }))

/** 顶层段落下标范围 → 文档区间（含前后各 1 段）。 */
function expandToBlocks(doc: ProseMirrorNode, range: HoverRange): HoverRange {
  const size = doc.content.size
  const startIndex = Math.max(0, doc.resolve(Math.min(Math.max(0, range.from), size)).index(0) - 1)
  const endIndex = Math.min(doc.childCount - 1, doc.resolve(Math.min(Math.max(0, range.to), size)).index(0) + 1)
  let from = 0
  for (let i = 0; i < startIndex; i += 1) from += doc.child(i).nodeSize
  let to = from
  for (let i = startIndex; i <= endIndex && i < doc.childCount; i += 1) to += doc.child(i).nodeSize
  return { from, to }
}

/** 降级判断：章节过长，或全章匹配超时。 */
export const shouldDegrade = (textLength: number, fullMs: number): boolean =>
  textLength > MATCHER_LIMITS.chapterChars || fullMs > MATCHER_LIMITS.fullBudgetMs

function fullCompute(doc: ProseMirrorNode, state: CharacterHoverState): CharacterHoverState {
  const { matcher } = state
  if (!matcher) return { ...state, decorations: DecorationSet.empty, degraded: false, dirty: [] }
  const length = doc.content.size
  if (length > MATCHER_LIMITS.chapterChars) return viewportCompute(doc, { ...state, degraded: true, dirty: [] })
  const start = now()
  const hits = hitsInRange(doc, matcher)
  const elapsed = now() - start
  if (shouldDegrade(length, elapsed)) return viewportCompute(doc, { ...state, degraded: true, dirty: [], lastFullMs: elapsed })
  return { ...state, degraded: false, dirty: [], lastFullMs: elapsed, decorations: DecorationSet.create(doc, toDecorations(hits, state.ignored)) }
}

function viewportCompute(doc: ProseMirrorNode, state: CharacterHoverState): CharacterHoverState {
  if (!state.matcher) return { ...state, decorations: DecorationSet.empty, dirty: [] }
  const range = state.viewport ? expandToBlocks(doc, state.viewport) : { from: 0, to: Math.min(doc.content.size, 20_000) }
  return { ...state, dirty: [], decorations: DecorationSet.create(doc, toDecorations(hitsInRange(doc, state.matcher, range.from, range.to), state.ignored)) }
}

/** 展开到段落后合并重叠/相邻区间：同一长段里上千处改动（全部替换 / 撤销）只扫一遍，避免 O(改动数 × 段长)。 */
export function mergeRanges(ranges: HoverRange[]): HoverRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from)
  const merged: HoverRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

function incrementalCompute(doc: ProseMirrorNode, state: CharacterHoverState): CharacterHoverState {
  if (!state.matcher || !state.dirty.length) return { ...state, dirty: [] }
  if (state.degraded) return viewportCompute(doc, state)
  let decorations = state.decorations
  for (const range of mergeRanges(state.dirty.map((dirty) => expandToBlocks(doc, dirty)))) {
    decorations = decorations.remove(decorations.find(range.from, range.to))
    decorations = decorations.add(doc, toDecorations(hitsInRange(doc, state.matcher, range.from, range.to), state.ignored))
  }
  return { ...state, dirty: [], decorations }
}

const mapRanges = (ranges: HoverRange[], tr: Transaction): HoverRange[] => ranges
  .map((range) => ({ from: tr.mapping.map(range.from, 1), to: tr.mapping.map(range.to, -1) })).filter((range) => range.to > range.from)

function changedRanges(tr: Transaction): HoverRange[] {
  const ranges: HoverRange[] = []
  tr.mapping.maps.forEach((map, index) => map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
    const rest = tr.mapping.slice(index + 1)
    ranges.push({ from: rest.map(newStart, -1), to: rest.map(newEnd, 1) })
  }))
  return ranges
}

export function applyHover(state: CharacterHoverState, tr: Transaction, doc: ProseMirrorNode): CharacterHoverState {
  const meta = tr.getMeta(characterHoverKey) as CharacterHoverMeta | undefined
  let next = state
  if (tr.docChanged) {
    const dirty = [...mapRanges(state.dirty, tr), ...changedRanges(tr)].map((range) => ({ from: range.from, to: Math.max(range.from, range.to) }))
    next = { ...state, decorations: state.decorations.map(tr.mapping, doc), ignored: mapRanges(state.ignored, tr), dirty,
      viewport: state.viewport ? { from: tr.mapping.map(state.viewport.from, -1), to: tr.mapping.map(state.viewport.to, 1) } : undefined }
  }
  if (!meta) return next
  if (meta.type === 'setMatcher') return fullCompute(doc, { ...next, matcher: meta.matcher })
  if (meta.type === 'recompute') return incrementalCompute(doc, next)
  if (meta.type === 'viewport') return next.degraded ? viewportCompute(doc, { ...next, viewport: meta.range }) : { ...next, viewport: meta.range }
  // ignoreAt：只移除这一处的下划线
  const ignored = [...next.ignored, meta.range]
  return { ...next, ignored, decorations: next.decorations.remove(next.decorations.find(meta.range.from, meta.range.to).filter((item) => item.from === meta.range.from && item.to === meta.range.to)) }
}

/** 光标位置上的命中（Ctrl+Shift+K）。 */
export function hitAt(state: EditorState, pos: number): DecoratedHit | undefined {
  const plugin = characterHoverKey.getState(state)
  if (!plugin) return undefined
  const candidates = plugin.decorations.find(pos, pos)
  // 光标正好在两处命中之间时优先取后一处（从它开头开始）
  const found = candidates.find((item) => item.from <= pos && pos < item.to) ?? candidates.find((item) => item.from <= pos && pos <= item.to)
  if (!found) return undefined
  const spec = found.spec as { hit: { term: string; characterIds: string[] } }
  return { ...spec.hit, from: 0, to: 0, pmFrom: found.from, pmTo: found.to }
}

export interface CharacterHoverOptions {
  onShortcut?(view: EditorView): void
  debounceMs?: number
}

const isShortcut = (event: KeyboardEvent): boolean => event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'k'

export function characterHoverPlugin(options: CharacterHoverOptions = {}): Plugin<CharacterHoverState> {
  return new Plugin<CharacterHoverState>({
    key: characterHoverKey,
    state: {
      init: () => ({ matcher: null, decorations: DecorationSet.empty, degraded: false, dirty: [], ignored: [] }),
      apply: (tr, value, _old, newState) => applyHover(value, tr, newState.doc)
    },
    props: {
      decorations: (state) => characterHoverKey.getState(state)?.decorations,
      handleKeyDown: (view, event) => {
        if (!isShortcut(event)) return false
        options.onShortcut?.(view)
        return true
      }
    },
    view: (view) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let frame = 0
      const reportViewport = (): void => {
        frame = 0
        const state = characterHoverKey.getState(view.state)
        if (!state?.degraded || view.isDestroyed) return
        const rect = view.dom.getBoundingClientRect()
        const left = rect.left + Math.min(24, rect.width / 2)
        const top = Math.max(rect.top + 1, 1)
        const bottom = Math.min(rect.bottom - 1, window.innerHeight - 1)
        const from = view.posAtCoords({ left, top })?.pos ?? 0
        const to = view.posAtCoords({ left, top: Math.max(top, bottom) })?.pos ?? Math.min(view.state.doc.content.size, from + 4000)
        const span = Math.max(1, to - from)
        // 上下各 2 屏（按可见区间的字符跨度估算）
        const range = { from: Math.max(0, from - 2 * span), to: Math.min(view.state.doc.content.size, to + 2 * span) }
        if (state.viewport && Math.abs(state.viewport.from - range.from) < span / 2 && Math.abs(state.viewport.to - range.to) < span / 2) return
        view.dispatch(view.state.tr.setMeta(characterHoverKey, { type: 'viewport', range } satisfies CharacterHoverMeta).setMeta('addToHistory', false))
      }
      const onScroll = (): void => { if (!frame) frame = requestAnimationFrame(reportViewport) }
      // 滚动事件不冒泡：在 document 捕获阶段监听，任何滚动容器都能触发
      document.addEventListener('scroll', onScroll, { capture: true, passive: true })
      return {
        update: (current, previous) => {
          const state = characterHoverKey.getState(current.state)
          const before = characterHoverKey.getState(previous)
          if (state?.degraded && !before?.degraded) onScroll()
          if (!state?.dirty.length || current.state.doc === previous.doc) return
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = undefined
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(characterHoverKey, { type: 'recompute' } satisfies CharacterHoverMeta).setMeta('addToHistory', false))
          }, options.debounceMs ?? HOVER_DEBOUNCE_MS)
        },
        destroy: () => { if (timer) clearTimeout(timer); if (frame) cancelAnimationFrame(frame); document.removeEventListener('scroll', onScroll, { capture: true }) }
      }
    }
  })
}

export const setHoverMatcher = (view: EditorView, matcher: NameMatcher | null): void =>
  view.dispatch(view.state.tr.setMeta(characterHoverKey, { type: 'setMatcher', matcher } satisfies CharacterHoverMeta).setMeta('addToHistory', false))
export const ignoreHoverAt = (view: EditorView, range: HoverRange): void =>
  view.dispatch(view.state.tr.setMeta(characterHoverKey, { type: 'ignoreAt', range } satisfies CharacterHoverMeta).setMeta('addToHistory', false))
export const isHoverDegraded = (state: EditorState): boolean => Boolean(characterHoverKey.getState(state)?.degraded)

/** 人物卡或悬停偏好变化后通知编辑器重建匹配器（renderer 内部事件，不经 IPC）。 */
export const CHARACTERS_CHANGED_EVENT = 'workspace:characters-changed'
export const notifyCharactersChanged = (projectId: string): void => { window.dispatchEvent(new CustomEvent(CHARACTERS_CHANGED_EVENT, { detail: { projectId } })) }
