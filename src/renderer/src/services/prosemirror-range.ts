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

export function findTextRange(doc: ProseMirrorNode, text: string): ProseMirrorRange | undefined {
  if (!text) return undefined
  let result: ProseMirrorRange | undefined
  doc.descendants((node, position) => {
    if (result || !node.isText || !node.text) return true
    const index = node.text.indexOf(text)
    if (index >= 0) result = { from: position + index, to: position + index + text.length }
    return !result
  })
  return result
}
