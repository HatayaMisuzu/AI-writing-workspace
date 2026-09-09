export interface TextChunk { text: string; from: number; to: number }

/** Splits long text deterministically while preserving absolute UTF-16 offsets. */
export const splitText = (text: string, maxChars: number): TextChunk[] => {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('TEXT_CHUNK_SIZE_INVALID')
  if (!text) return [{ text: '', from: 0, to: 0 }]
  const chunks: TextChunk[] = []
  let from = 0
  while (from < text.length) {
    let to = Math.min(text.length, from + maxChars)
    if (to < text.length) {
      const paragraph = text.lastIndexOf('\n\n', to)
      const line = text.lastIndexOf('\n', to)
      const punctuation = Math.max(text.lastIndexOf('。', to), text.lastIndexOf('！', to), text.lastIndexOf('？', to)) + 1
      const boundary = Math.max(paragraph >= from + Math.floor(maxChars * 0.5) ? paragraph + 2 : 0,
        line >= from + Math.floor(maxChars * 0.5) ? line + 1 : 0,
        punctuation >= from + Math.floor(maxChars * 0.5) ? punctuation : 0)
      if (boundary > from) to = boundary
      if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1]) && /[\uDC00-\uDFFF]/.test(text[to])) to -= 1
    }
    chunks.push({ text: text.slice(from, to), from, to })
    from = to
  }
  return chunks
}
