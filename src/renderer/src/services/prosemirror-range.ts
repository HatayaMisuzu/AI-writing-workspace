import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export interface ProseMirrorRange { from: number; to: number }

type TextSpan = { textFrom: number; textTo: number; pmFrom: number; pmTo: number }

/** Mirrors Tiptap getText({ blockSeparator: '\n\n' }) and records only real, selectable PM spans. */
export function buildTiptapTextSpans(doc: ProseMirrorNode): { text: string; spans: TextSpan[] } {
  let text = ''
  const spans: TextSpan[] = []
  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (node.isBlock && pos > 0) text += '\n\n'
    if (node.isText) {
      const value = node.text ?? ''
      const textFrom = text.length
      text += value
      spans.push({ textFrom, textTo: text.length, pmFrom: pos, pmTo: pos + value.length })
      return
    }
    if (node.type.name === 'hardBreak') {
      const textFrom = text.length
      text += '\n'
      spans.push({ textFrom, textTo: text.length, pmFrom: pos, pmTo: pos + node.nodeSize })
    }
  })
  return { text, spans }
}

/** Maps offsets from getText({ blockSeparator: '\n\n' }) back into the ProseMirror document. */
export function plainTextRangeToPm(doc: ProseMirrorNode, from: number, to: number): ProseMirrorRange | undefined {
  if (from < 0 || to < from) return undefined
  const { spans } = buildTiptapTextSpans(doc)
  if (from === to) {
    const span = spans.find((item) => from >= item.textFrom && from <= item.textTo)
    return span ? { from: span.pmFrom + from - span.textFrom, to: span.pmFrom + to - span.textFrom } : undefined
  }
  const first = spans.find((item) => from >= item.textFrom && from < item.textTo)
  const last = spans.find((item) => to > item.textFrom && to <= item.textTo)
  if (!first || !last) return undefined
  // Virtual block separators cannot be represented as an exact PM text selection.
  const covered = spans.filter((item) => item.textTo > from && item.textFrom < to)
  if (covered.some((item, index) => index > 0 && item.textFrom !== covered[index - 1].textTo)) return undefined
  return { from: first.pmFrom + from - first.textFrom, to: last.pmFrom + to - last.textFrom }
}

export function findTextRanges(doc: ProseMirrorNode, text: string): ProseMirrorRange[] {
  if (!text) return []
  const plainText = buildTiptapTextSpans(doc).text
  const ranges: ProseMirrorRange[] = []
  for (let from = 0; from <= plainText.length - text.length;) {
    const index = plainText.indexOf(text, from)
    if (index < 0) break
    const range = plainTextRangeToPm(doc, index, index + text.length)
    if (range && doc.textBetween(range.from, range.to, '\n\n') === text) ranges.push(range)
    from = index + Math.max(1, text.length)
  }
  return ranges
}

export function findTextRange(doc: ProseMirrorNode, text: string, occurrence = 1): ProseMirrorRange | undefined {
  if (!Number.isInteger(occurrence) || occurrence < 1) return undefined
  return findTextRanges(doc, text)[occurrence - 1]
}
