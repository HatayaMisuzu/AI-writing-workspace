/**
 * 超长单段分块显示（PR37 复验 ①）。
 * 一个 19.9 万字的单段落在 Chromium 里是一个行内格式化上下文：任何改动（替换一个词、抽屉里增删节点触发的祖先重排）
 * 都要把整段约 1.1 万行重新断行，本机每次 4–8s。这里只加 inline Decoration（不改文档 / editor_json）：
 * 把超长段落按句末切成约 1500 字一块，每块是 display:block + content-visibility:auto，
 * 改动只重排所在那一块，屏外块跳过布局。代价：块边界处会换行（落在句末标点之后）。
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/** 段落超过这么多字才分块（普通段落不受影响）。 */
export const LONG_PARAGRAPH_CHARS = 6000
/** 目标块长。 */
export const PARAGRAPH_CHUNK_CHARS = 1500
/** 从目标块长往后最多找这么远的句末标点；找不到就在目标长度处切。 */
const BOUNDARY_SEARCH = 500
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n'])
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '》', '"', '\''])

/** 块边界（块内偏移，升序，不含 0 与 length）。文本长度不超过阈值时返回空数组。 */
export const chunkBoundaries = (text: string, chunk = PARAGRAPH_CHUNK_CHARS, threshold = LONG_PARAGRAPH_CHARS): number[] => {
  if (text.length <= threshold) return []
  const cuts: number[] = []
  let start = 0
  while (text.length - start > chunk * 1.5) {
    const target = start + chunk
    let cut = target
    for (let index = target; index < Math.min(text.length - 1, target + BOUNDARY_SEARCH); index += 1) {
      if (SENTENCE_END.has(text[index])) {
        cut = index + 1
        while (cut < text.length && CLOSERS.has(text[cut])) cut += 1
        break
      }
    }
    if (cut >= text.length) break
    cuts.push(cut)
    start = cut
  }
  return cuts
}

/**
 * 只分「单个无格式文本节点」的超长段落：ProseMirror 的 inline Decoration 按文本片段分别包裹，
 * 段落里有加粗等格式（或别的 inline 装饰）时，一块会被拆成几个 display:block 的片段而错误换行。
 * 人物悬停因此跳过这类段落（见 character-hover.ts hitsInRange）。
 */
export const isChunkedParagraph = (block: ProseMirrorNode): boolean => block.isTextblock
  && block.content.size > LONG_PARAGRAPH_CHARS && block.childCount === 1
  && Boolean(block.firstChild?.isText) && (block.firstChild?.marks.length ?? 1) === 0

const blockText = (block: ProseMirrorNode): string => block.textBetween(0, block.content.size, undefined, '\uFFFC')

export const chunkDecorations = (doc: ProseMirrorNode): DecorationSet => {
  const decorations: Decoration[] = []
  doc.forEach((block, offset) => {
    if (!isChunkedParagraph(block)) return
    const text = blockText(block)
    const cuts = chunkBoundaries(text)
    if (!cuts.length) return
    const start = offset + 1
    let previous = 0
    for (const cut of [...cuts, text.length]) {
      decorations.push(Decoration.inline(start + previous, start + cut, { class: previous === 0 ? 'long-paragraph-chunk first' : 'long-paragraph-chunk' }))
      previous = cut
    }
  })
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

export const longParagraphChunksKey = new PluginKey<DecorationSet>('longParagraphChunks')

export function longParagraphChunksPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: longParagraphChunksKey,
    state: {
      init: (_, state) => chunkDecorations(state.doc),
      apply: (tr, previous) => tr.docChanged ? chunkDecorations(tr.doc) : previous
    },
    props: { decorations: (state) => longParagraphChunksKey.getState(state) }
  })
}
