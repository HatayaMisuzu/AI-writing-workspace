import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export interface ProseMirrorRange { from: number; to: number }

/** Maps offsets from getText({ blockSeparator: '\n\n' }) back into the ProseMirror document. */
export function plainTextRangeToPm(doc: ProseMirrorNode, from: number, to: number): ProseMirrorRange | undefined {
  if (from < 0 || to < from) return undefined
  let plainOffset = 0
  let result: ProseMirrorRange | undefined
  doc.forEach((node, position) => {
    if (result) return
    const blockText = node.textBetween(0, node.content.size, '\n')
    const blockEnd = plainOffset + blockText.length
    if (from >= plainOffset && to <= blockEnd) {
      result = { from: position + 1 + from - plainOffset, to: position + 1 + to - plainOffset }
    }
    plainOffset = blockEnd + 2
  })
  return result
}

export function findTextRanges(doc: ProseMirrorNode, text: string): ProseMirrorRange[] {
  if (!text) return []
  const plainText = doc.textBetween(0, doc.content.size, '\n\n')
  const ranges: ProseMirrorRange[] = []
  for (let from = 0; from <= plainText.length - text.length;) {
    const index = plainText.indexOf(text, from)
    if (index < 0) break
    const range = plainTextRangeToPm(doc, index, index + text.length)
    if (range) ranges.push(range)
    from = index + Math.max(1, text.length)
  }
  return ranges
}

export function findTextRange(doc: ProseMirrorNode, text: string, occurrence = 1): ProseMirrorRange | undefined {
  if (!Number.isInteger(occurrence) || occurrence < 1) return undefined
  return findTextRanges(doc, text)[occurrence - 1]
}
