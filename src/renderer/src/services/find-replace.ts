/**
 * 本章查找替换（P3 find-replace，纯函数部分，无 DOM）。
 * - 逐个文本块搜索（与人物悬停 / 分块同一套「块内偏移 ↔ PM 位置」：非文本叶子占 1 位 U+FFFC），命中不跨段。
 * - 选项只有「区分大小写」「正则」。普通文本也转成转义后的正则，大小写不敏感用 i 标志（不用 toLowerCase，避免长度变化导致偏移错位）。
 * - 正则错误返回 error，不抛出；空匹配跳过；命中数有上限（超出时 truncated，界面明确提示）。
 * - 替换：一个事务里倒序替换（不需要位置映射），调用方负责 closeHistory 使其成为独立的一个撤销步。
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'

export const FIND_MATCH_LIMIT = 20_000
export const FIND_DEBOUNCE_MS = 150

export interface FindOptions { caseSensitive: boolean; regex: boolean }
export interface FindMatch {
  /** PM 位置 */
  from: number
  to: number
  /** 命中原文 */
  text: string
  /** 正则捕获组（替换模板 $1 / $<name> 用） */
  groups?: string[]
  named?: Record<string, string>
}
export interface FindResult { matches: FindMatch[]; error?: string; truncated: boolean }

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function buildFindRegExp(query: string, options: FindOptions): { pattern?: RegExp; error?: string } {
  if (!query) return {}
  try {
    return { pattern: new RegExp(options.regex ? query : escapeRegExp(query), `gu${options.caseSensitive ? '' : 'i'}`) }
  } catch (error) {
    return { error: `正则有误：${error instanceof Error ? error.message.replace(/^Invalid regular expression: /, '') : String(error)}` }
  }
}

const blockText = (block: ProseMirrorNode): string => block.textBetween(0, block.content.size, undefined, '\uFFFC')

export function findMatches(doc: ProseMirrorNode, query: string, options: FindOptions, limit = FIND_MATCH_LIMIT): FindResult {
  const { pattern, error } = buildFindRegExp(query, options)
  if (!pattern) return { matches: [], error, truncated: false }
  const matches: FindMatch[] = []
  let truncated = false
  doc.descendants((node, pos) => {
    if (truncated) return false
    if (!node.isTextblock) return true
    const text = blockText(node)
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match[0].length === 0) { pattern.lastIndex += text.codePointAt(pattern.lastIndex)! > 0xffff ? 2 : 1; continue }
      if (match[0].includes('\uFFFC')) continue
      if (matches.length >= limit) { truncated = true; break }
      matches.push({ from: pos + 1 + match.index, to: pos + 1 + match.index + match[0].length, text: match[0],
        ...(options.regex ? { groups: match.slice(1).map((group) => group ?? ''), named: match.groups ? Object.fromEntries(Object.entries(match.groups).map(([key, value]) => [key, value ?? ''])) : undefined } : {}) })
    }
    return false
  })
  return { matches, truncated }
}

/** 正则模式下展开 $$ / $& / $1–$99 / $<name>；普通模式原样替换。 */
export function expandReplacement(template: string, match: FindMatch, regex: boolean): string {
  if (!regex) return template
  return template.replace(/\$(\$|&|<([^>]+)>|(\d{1,2}))/g, (whole, token: string, name?: string, digits?: string) => {
    if (token === '$') return '$'
    if (token === '&') return match.text
    if (name !== undefined) return match.named?.[name] ?? whole
    const index = Number(digits)
    const groups = match.groups ?? []
    if (index >= 1 && index <= groups.length) return groups[index - 1]
    // $12 但只有 1 个分组时按 $1 + "2"（与 String.prototype.replace 一致）
    if (digits && digits.length === 2 && Number(digits[0]) >= 1 && Number(digits[0]) <= groups.length) return groups[Number(digits[0]) - 1] + digits[1]
    return whole
  })
}

/** 第一个起点 ≥ pos 的命中下标（没有则回到 0）；空列表返回 -1。 */
export function matchIndexAtOrAfter(matches: FindMatch[], pos: number): number {
  if (!matches.length) return -1
  let low = 0; let high = matches.length
  while (low < high) { const mid = (low + high) >> 1; if (matches[mid].from < pos) low = mid + 1; else high = mid }
  return low < matches.length ? low : 0
}

/**
 * 在 tr 上替换给定命中（位置均为 tr 起点文档的位置，升序）。返回替换条数。
 * 倒序逐条替换，不需要位置映射；每条先核对原文，不符跳过。
 * 优化：同一段落是「单个无格式文本节点」且命中 ≥ BULK_THRESHOLD 时，整段文字一次拼好再替换成一个文本节点
 * （19.9 万字单段替换 1000 处时，避免 1000 次复制整段字符串）。
 */
export const BULK_THRESHOLD = 32
export function applyReplacements(tr: Transaction, matches: FindMatch[], replacement: string, regex: boolean): number {
  const doc = tr.doc
  let count = 0
  let index = matches.length - 1
  while (index >= 0) {
    const $pos = doc.resolve(matches[index].from)
    const block = $pos.parent
    const blockStart = $pos.start()
    let first = index
    while (first > 0 && matches[first - 1].from >= blockStart) first -= 1
    const group = matches.slice(first, index + 1)
    const single = block.childCount === 1 && block.firstChild!.isText && block.firstChild!.marks.length === 0
    if (single && group.length >= BULK_THRESHOLD) {
      const text = block.textContent
      let out = ''; let cursor = 0; let replaced = 0
      for (const match of group) {
        const start = match.from - blockStart; const end = match.to - blockStart
        if (start < cursor || text.slice(start, end) !== match.text) continue
        out += text.slice(cursor, start) + expandReplacement(replacement, match, regex); cursor = end; replaced += 1
      }
      out += text.slice(cursor)
      if (replaced) {
        const end = blockStart + block.content.size
        if (out) tr.replaceWith(blockStart, end, doc.type.schema.text(out)); else tr.delete(blockStart, end)
      }
      count += replaced
    } else {
      for (let k = group.length - 1; k >= 0; k -= 1) {
        const match = group[k]
        if (tr.doc.textBetween(match.from, match.to, '\uFFFC', '\uFFFC') !== match.text) continue
        const text = expandReplacement(replacement, match, regex)
        if (text) tr.insertText(text, match.from, match.to); else tr.delete(match.from, match.to)
        count += 1
      }
    }
    index = first - 1
  }
  return count
}

export const findCountLabel = (current: number, total: number, truncated: boolean): string =>
  total === 0 ? '无匹配' : `第 ${current + 1} / 共 ${total}${truncated ? '+' : ''} 处`
