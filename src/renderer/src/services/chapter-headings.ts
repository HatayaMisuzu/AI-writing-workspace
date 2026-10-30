/**
 * 本章大纲（P3 outline）：列出章内标题（heading 节点）与场景分隔（单独成段的 ***、——、◇ 等）。
 * 只看顶层块，O(块数)；长段落不取全文（只看长度 ≤ 40 的段落是否分隔符）。预览取后面正文的前几个字。
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export const OUTLINE_PREVIEW_CHARS = 16
const SEPARATOR_MAX = 40

export interface ChapterHeading {
  kind: 'heading' | 'scene'
  /** heading 级别（场景分隔为 0） */
  level: number
  /** 标题文字，或分隔符本身 */
  label: string
  /** 后面正文的前几个字 */
  preview: string
  /** 跳转后光标位置（PM 位置：标题文字起点 / 分隔后下一段起点） */
  pos: number
}

/** 去空白后只由常见分隔符号组成：*** / ＊＊＊ / ——（≥2）/ --- / ◇（≥1）/ ◆ / ※ / # # # / ~~~ / ·· · / ○ ● □ ■ ☆ ★ / ==== / ____ */
export function isSceneSeparator(text: string): boolean {
  const compact = text.replace(/[\s\u3000]/g, '')
  if (!compact || compact.length > SEPARATOR_MAX) return false
  if (/^[◇◆※○●□■☆★]+$/u.test(compact)) return true
  if (/^[—─]{2,}$/u.test(compact)) return true
  return /^[*＊#＃~～·•\-=_◇◆※○●□■☆★—]{3,}$/u.test(compact)
}

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > OUTLINE_PREVIEW_CHARS ? `${flat.slice(0, OUTLINE_PREVIEW_CHARS)}…` : flat
}

/** 从 index 开始找第一个非空、非分隔的段落，取它的预览（只读前 OUTLINE_PREVIEW_CHARS×2 字）。 */
function nextPreview(doc: ProseMirrorNode, index: number): string {
  for (let i = index; i < doc.childCount; i += 1) {
    const block = doc.child(i)
    if (!block.isTextblock || block.content.size === 0) continue
    const head = block.textBetween(0, Math.min(block.content.size, OUTLINE_PREVIEW_CHARS * 2), ' ', ' ')
    if (block.type.name === 'heading' || (block.content.size <= SEPARATOR_MAX && isSceneSeparator(block.textContent))) return ''
    if (head.trim()) return preview(head)
  }
  return ''
}

export function chapterHeadings(doc: ProseMirrorNode): ChapterHeading[] {
  const items: ChapterHeading[] = []
  let offset = 0
  for (let index = 0; index < doc.childCount; index += 1) {
    const block = doc.child(index)
    const start = offset
    offset += block.nodeSize
    if (block.type.name === 'heading') {
      items.push({ kind: 'heading', level: Number(block.attrs.level) || 1, label: preview(block.textContent) || '（无标题）', preview: nextPreview(doc, index + 1), pos: start + 1 })
      continue
    }
    if (!block.isTextblock || block.content.size === 0 || block.content.size > SEPARATOR_MAX) continue
    const text = block.textContent
    if (!isSceneSeparator(text)) continue
    // 光标放到分隔之后的下一段起点；分隔是最后一段时放在分隔段末尾
    const pos = index + 1 < doc.childCount && doc.child(index + 1).isTextblock ? offset + 1 : start + 1 + block.content.size
    items.push({ kind: 'scene', level: 0, label: text.trim(), preview: nextPreview(doc, index + 1), pos })
  }
  return items
}
