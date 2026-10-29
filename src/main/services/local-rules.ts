/**
 * F13 本地规则（纯本地：不联网、不调 AI）。现有 lintChineseText 不改，这里在它外面组合新规则：
 * - 词表：全局 + 作品级合并后，用 F14 的 NameMatcher（最长优先、不重叠；中文子串匹配，纯 ASCII 字母数字要求词边界）。
 *   单字词条也参与（作者自己写进词表的就是要查的）。
 * - 重复字：默认关闭；只查作者勾选的字的紧邻重复，叠词白名单不报。
 * - 全半角：只查两个汉字之间的半角 , ( )。
 * - 超过 20 万字：只跑标点规则（longChapter=true）。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { LintGroup, LintRules, LocalLintIssue } from '../../shared/domain'
import { NameMatcher, normalizeTerm } from '../../shared/name-matcher'
import { textIdentity } from '../../shared/text-identity'
import { mergeWordlists, type WordlistEntry } from '../../shared/wordlist'
import { lintChineseText } from './local-linter'

export const LONG_CHAPTER_CHARS = 200_000
export const REPEAT_CHAR_CANDIDATES = ['的', '了', '是', '在'] as const
export const DEFAULT_REDUPLICATION_WHITELIST = ['看看', '渐渐', '常常', '慢慢', '刚刚', '往往', '天天', '人人', '默默', '悄悄', '轻轻', '微微', '静静', '纷纷', '好好', '偏偏', '仅仅', '隐隐', '谢谢', '妈妈', '爸爸', '哥哥', '姐姐', '弟弟', '妹妹', '爷爷', '奶奶', '想想', '试试', '说说', '走走']
export const DEFAULT_LINT_RULES: LintRules = { punctuation: true, wordlist: true, halfwidth: true, repeatChar: false, repeatChars: [], reduplicationWhitelist: DEFAULT_REDUPLICATION_WHITELIST }

/** settings_json.lintRules → 规则（缺项取默认，坏数据按默认处理）。 */
export function readLintRules(raw: unknown): LintRules {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const bool = (key: keyof LintRules, fallback: boolean): boolean => typeof value[key] === 'boolean' ? value[key] as boolean : fallback
  const strings = (key: keyof LintRules, fallback: string[]): string[] => Array.isArray(value[key])
    ? (value[key] as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : fallback
  return {
    punctuation: bool('punctuation', true), wordlist: bool('wordlist', true), halfwidth: bool('halfwidth', true), repeatChar: bool('repeatChar', false),
    repeatChars: strings('repeatChars', []).filter((item) => [...item].length === 1), reduplicationWhitelist: strings('reduplicationWhitelist', DEFAULT_REDUPLICATION_WHITELIST)
  }
}

type CompiledWordlist = { matcher: NameMatcher; entries: Map<string, WordlistEntry> }
const cache = new Map<string, CompiledWordlist>()
const CACHE_SIZE = 8
/** 按「全局文本 + 作品文本」的 hash 缓存匹配器；词表变了才重建，lint 时不重建。 */
export function compileWordlist(globalText: string, projectText: string): CompiledWordlist {
  const key = createHash('sha256').update(globalText).update('\u0000').update(projectText).digest('hex')
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }
  const entries = mergeWordlists(globalText, projectText)
  const terms = [...entries.keys()].map((term) => ({ term, characterId: term, kind: 'name' as const }))
  const compiled = { matcher: new NameMatcher(terms, { enabledSingleTerms: terms }), entries }
  cache.set(key, compiled)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  return compiled
}
export const wordlistCacheSize = (): number => cache.size

export const HALFWIDTH_MAP: Record<string, string> = { ',': '，', '(': '（', ')': '）' }
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface LintProjectInput { text: string; documentId: string; sourceRevision: number; globalText: string; projectText: string; rules: LintRules }

export function lintProject(input: LintProjectInput): { issues: LocalLintIssue[]; longChapter: boolean } {
  const { text, documentId, sourceRevision, rules } = input
  const sourceTextHash = textIdentity(text)
  const issues: LocalLintIssue[] = []
  if (rules.punctuation) {
    for (const issue of lintChineseText(text, documentId, sourceRevision)) issues.push({ ...issue, ruleKey: issue.kind, group: 'punctuation' })
  }
  const longChapter = text.length > LONG_CHAPTER_CHARS
  const push = (from: number, to: number, group: LintGroup, ruleKey: string, kind: string, message: string, replacement?: string): void => {
    issues.push({ id: randomUUID(), documentId, sourceRevision, from, to, severity: 'warning', kind, message,
      ...(replacement !== undefined ? { replacement } : {}), sourceTextHash, originalText: text.slice(from, to), ruleKey, group })
  }
  if (!longChapter) {
    if (rules.wordlist && (input.globalText || input.projectText)) {
      const { matcher, entries } = compileWordlist(input.globalText, input.projectText)
      for (const hit of matcher.match(text)) {
        const entry = entries.get(normalizeTerm(hit.term))
        if (!entry) continue
        if (entry.replacement !== undefined) push(hit.from, hit.to, 'wordlist_replace', `wordlist:${normalizeTerm(entry.term)}`, 'wordlist_replace', `词表替换：「${entry.term}」→「${entry.replacement}」`, entry.replacement)
        else push(hit.from, hit.to, 'wordlist_hint', `wordlist:${normalizeTerm(entry.term)}`, 'wordlist_hint', `词表提示：「${entry.term}」`)
      }
    }
    if (rules.repeatChar && rules.repeatChars.length) {
      const whitelist = new Set(rules.reduplicationWhitelist)
      for (const char of rules.repeatChars) {
        for (const match of text.matchAll(new RegExp(`(?:${escapeRegex(char)}){2,}`, 'gu'))) {
          if (match.index === undefined || whitelist.has(match[0])) continue
          push(match.index, match.index + match[0].length, 'repeat_char', `repeat:${char}`, 'repeat_char', `「${char}」紧邻重复，可能是误输入。`, char)
        }
      }
    }
    if (rules.halfwidth) {
      for (const match of text.matchAll(/(?<=[\u4e00-\u9fff])[,()](?=[\u4e00-\u9fff])/g)) {
        if (match.index === undefined) continue
        push(match.index, match.index + 1, 'halfwidth', 'halfwidth', 'halfwidth', `中文之间使用了半角「${match[0]}」。`, HALFWIDTH_MAP[match[0]])
      }
    }
  }
  return { issues: issues.toSorted((a, b) => a.from - b.from || a.to - b.to), longChapter }
}
