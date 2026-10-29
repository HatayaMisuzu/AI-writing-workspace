/**
 * F13 自定义词表（main / renderer 共用的纯函数，不联网、不调模型）。
 * 格式：UTF-8 纯文本，每行一条。
 * - `错词=>正词`：替换类；`错词`：提示类（只提示，不给替换）；
 * - `!错词`：仅作品级有意义，在本作品关掉同名全局规则；
 * - `# 注释` 与空行忽略。同一层里同一词出现多次时，以最后一行为准。
 */
import { normalizeTerm } from './name-matcher'

export const WORDLIST_LIMITS = { entries: 20_000, termChars: 50, projectBytes: 1_000_000 } as const

export type WordlistLine =
  | { kind: 'replace'; term: string; replacement: string; line: number }
  | { kind: 'hint'; term: string; line: number }
  | { kind: 'disable'; term: string; line: number }
export interface WordlistError { line: number; reason: string; text: string }
export interface ParsedWordlist { lines: WordlistLine[]; errors: WordlistError[] }
/** 合并后的有效条目（键为规范化后的词）。 */
export type WordlistEntry = { term: string; replacement?: string }

const charLength = (value: string): number => [...value].length

export function parseWordlist(text: string): ParsedWordlist {
  const lines: WordlistLine[] = []
  const errors: WordlistError[] = []
  text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).forEach((raw, index) => {
    const line = index + 1
    const value = raw.trim()
    if (!value || value.startsWith('#')) return
    const fail = (reason: string): void => { errors.push({ line, reason, text: raw.slice(0, 80) }) }
    const tooLong = (word: string): boolean => charLength(word) > WORDLIST_LIMITS.termChars
    if (value.startsWith('!')) {
      const term = value.slice(1).trim()
      if (!term) return fail('「!」后缺少要禁用的词')
      if (tooLong(term)) return fail(`词条超过 ${WORDLIST_LIMITS.termChars} 字`)
      lines.push({ kind: 'disable', term, line }); return
    }
    const arrow = value.indexOf('=>')
    if (arrow >= 0) {
      const term = value.slice(0, arrow).trim()
      const replacement = value.slice(arrow + 2).trim()
      if (!term) return fail('「=>」左侧缺少错词')
      if (!replacement) return fail('「=>」右侧缺少正词')
      if (replacement.includes('=>')) return fail('一行只能有一个「=>」')
      if (tooLong(term) || tooLong(replacement)) return fail(`词条超过 ${WORDLIST_LIMITS.termChars} 字`)
      if (normalizeTerm(term) === normalizeTerm(replacement)) return fail('错词与正词相同')
      lines.push({ kind: 'replace', term, replacement, line }); return
    }
    if (tooLong(value)) return fail(`词条超过 ${WORDLIST_LIMITS.termChars} 字`)
    lines.push({ kind: 'hint', term: value, line })
  })
  return { lines, errors }
}

/** 单层：同一词以最后一行为准；disable 单独收集。 */
export function layerOf(parsed: ParsedWordlist): { entries: Map<string, WordlistEntry>; disabled: Set<string> } {
  const entries = new Map<string, WordlistEntry>()
  const disabled = new Set<string>()
  for (const item of parsed.lines) {
    const key = normalizeTerm(item.term)
    if (item.kind === 'disable') { disabled.add(key); entries.delete(key); continue }
    disabled.delete(key)
    entries.set(key, item.kind === 'replace' ? { term: item.term, replacement: item.replacement } : { term: item.term })
  }
  return { entries, disabled }
}

/** 全局在下、作品级在上：作品级覆盖同名全局条目；作品级 `!词` 删掉同名全局条目。全局层的 `!` 没有意义，忽略。 */
export function mergeWordlists(globalText: string, projectText: string): Map<string, WordlistEntry> {
  const merged = new Map(layerOf(parseWordlist(globalText)).entries)
  const project = layerOf(parseWordlist(projectText))
  for (const key of project.disabled) merged.delete(key)
  for (const [key, entry] of project.entries) merged.set(key, entry)
  return merged
}

export const entryCount = (text: string): number => parseWordlist(text).lines.length

/** 导出 / 规范化：一行一条，与 parseWordlist 往返一致。 */
export function serializeWordlist(lines: ReadonlyArray<WordlistLine | (WordlistEntry & { disabled?: boolean })>): string {
  return lines.map((item) => {
    if ('kind' in item) return item.kind === 'disable' ? `!${item.term}` : item.kind === 'replace' ? `${item.term}=>${item.replacement}` : item.term
    return item.disabled ? `!${item.term}` : item.replacement !== undefined ? `${item.term}=>${item.replacement}` : item.term
  }).join('\n') + (lines.length ? '\n' : '')
}

export interface WordlistImportPreview { token: string; added: number; overwritten: number; unchanged: number; errors: WordlistError[] }

/** 导入：把 incoming 叠加到 current（同一层），返回规范化后的新文本与三类计数。 */
export function planWordlistImport(currentText: string, incomingText: string): Omit<WordlistImportPreview, 'token'> & { nextText: string } {
  const current = parseWordlist(currentText)
  const incoming = parseWordlist(incomingText)
  const state = new Map<string, WordlistLine>()
  for (const item of current.lines) state.set(normalizeTerm(item.term), item)
  const before = new Map(state)
  const seen = new Map<string, WordlistLine>()
  for (const item of incoming.lines) seen.set(normalizeTerm(item.term), item)
  let added = 0; let overwritten = 0; let unchanged = 0
  const same = (a: WordlistLine, b: WordlistLine): boolean => a.kind === b.kind && (a.kind !== 'replace' || (b.kind === 'replace' && a.replacement === b.replacement))
  for (const [key, item] of seen) {
    const old = before.get(key)
    if (!old) added += 1
    else if (same(old, item)) unchanged += 1
    else overwritten += 1
    state.set(key, item)
  }
  return { added, overwritten, unchanged, errors: incoming.errors, nextText: serializeWordlist([...state.values()]) }
}
