/**
 * F14 人物名匹配器（main / renderer 共用的纯函数，不联网、不调模型）。
 * - 词表 [{ term, characterId, kind }] + 纯文本 → 不重叠命中区间；从左到右扫描，同一起点取最长。
 * - 中文不分词、不判边界；含英文/数字的词要求两侧不是 [A-Za-z0-9]。
 * - 同一 term 属于多张卡：同一区间返回全部 characterIds（不自动选）。
 * - 单字 term 默认不参与（可按 characterId+term 打开）；忽略列表中的 term 不参与。
 * - 比较前 trim、全角→半角；空 term 忽略。全角半角是 1:1 的 UTF-16 映射，区间下标即原文下标。
 */
export type NameTermKind = 'name' | 'alias'
export interface NameTerm { term: string; characterId: string; kind: NameTermKind }
export interface NameHit { from: number; to: number; term: string; characterIds: string[] }
export interface HoverTermRef { characterId: string; term: string }
export interface NameMatcherOptions {
  /** 作者手动打开的单字 term（characterId + term）。 */
  enabledSingleTerms?: readonly HoverTermRef[]
  /** 「此别名不提示」的 term（characterId + term）。 */
  ignoredTerms?: readonly HoverTermRef[]
}

export const MATCHER_LIMITS = { characters: 2000, terms: 10_000, chapterChars: 200_000, fullBudgetMs: 50, paragraphBudgetMs: 5 } as const

/** 全角 ASCII（U+FF01–FF5E）与全角空格 → 半角；其余字符不变（长度不变）。 */
export const normalizeWidth = (text: string): string => text.replace(/[\uFF01-\uFF5E\u3000]/g, (char) =>
  char === '\u3000' ? ' ' : String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
export const normalizeTerm = (term: string): string => normalizeWidth(term.trim())
export const isSingleCharTerm = (term: string): boolean => [...normalizeTerm(term)].length === 1
const refKey = (characterId: string, term: string): string => `${characterId}\u0000${normalizeTerm(term)}`
/** NaN（越界）→ false */
const isAlnumCode = (code: number): boolean => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)

/** settings_json 里的 term 列表：不是数组 → 空集；逐项校验，坏项跳过。 */
export const parseHoverTermRefs = (raw: unknown): HoverTermRef[] => {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is HoverTermRef => Boolean(item) && typeof item === 'object'
    && typeof (item as HoverTermRef).characterId === 'string' && typeof (item as HoverTermRef).term === 'string' && normalizeTerm((item as HoverTermRef).term).length > 0)
    .map((item) => ({ characterId: item.characterId, term: item.term }))
}

/** 人物卡 → 词表（name + aliases）。 */
export const termsFromCharacters = (characters: ReadonlyArray<{ id: string; name: string; aliases: readonly string[] }>): NameTerm[] =>
  characters.flatMap((character) => [
    { term: character.name, characterId: character.id, kind: 'name' as const },
    ...character.aliases.map((alias) => ({ term: alias, characterId: character.id, kind: 'alias' as const }))
  ])

type Node = { next: Map<number, number>; fail: number; out: number[] /* 命中的 term 长度（含经 fail 链继承） */; termLen: number }

export class NameMatcher {
  private readonly nodes: Node[] = [{ next: new Map(), fail: 0, out: [], termLen: 0 }]
  /** 规范化 term → { 原 term（首个）, characterIds } */
  private readonly owners = new Map<string, { term: string; characterIds: string[] }>()
  readonly termCount: number

  constructor(terms: readonly NameTerm[], options: NameMatcherOptions = {}) {
    const enabled = new Set((options.enabledSingleTerms ?? []).map((ref) => refKey(ref.characterId, ref.term)))
    const ignored = new Set((options.ignoredTerms ?? []).map((ref) => refKey(ref.characterId, ref.term)))
    for (const item of terms) {
      const normalized = normalizeTerm(item.term)
      if (!normalized) continue
      const key = refKey(item.characterId, normalized)
      if (ignored.has(key)) continue
      if (isSingleCharTerm(normalized) && !enabled.has(key)) continue
      const owner = this.owners.get(normalized)
      if (owner) { if (!owner.characterIds.includes(item.characterId)) owner.characterIds.push(item.characterId) }
      else this.owners.set(normalized, { term: item.term.trim(), characterIds: [item.characterId] })
    }
    this.termCount = this.owners.size
    for (const term of this.owners.keys()) this.insert(term)
    this.build()
  }

  private insert(term: string): void {
    let state = 0
    // 按 UTF-16 code unit 建自动机（代理对拆成两步，结果等价且更快）
    for (let index = 0; index < term.length; index += 1) {
      const char = term.charCodeAt(index)
      let next = this.nodes[state].next.get(char)
      if (next === undefined) { next = this.nodes.length; this.nodes.push({ next: new Map(), fail: 0, out: [], termLen: 0 }); this.nodes[state].next.set(char, next) }
      state = next
    }
    this.nodes[state].termLen = term.length
  }

  private build(): void {
    const queue: number[] = []
    for (const child of this.nodes[0].next.values()) { queue.push(child); this.nodes[child].out = this.nodes[child].termLen ? [this.nodes[child].termLen] : [] }
    for (let head = 0; head < queue.length; head += 1) {
      const state = queue[head]
      for (const [char, child] of this.nodes[state].next) {
        let fail = this.nodes[state].fail
        while (fail && !this.nodes[fail].next.has(char)) fail = this.nodes[fail].fail
        const target = this.nodes[fail].next.get(char)
        this.nodes[child].fail = target !== undefined && target !== child ? target : 0
        const own = this.nodes[child].termLen ? [this.nodes[child].termLen] : []
        this.nodes[child].out = [...own, ...this.nodes[this.nodes[child].fail].out]
        queue.push(child)
      }
    }
  }

  /** 扫描 text，返回不重叠命中（下标为 UTF-16 偏移）。 */
  match(text: string): NameHit[] {
    if (!this.termCount || !text) return []
    const source = normalizeWidth(text)
    const best = new Int32Array(source.length)
    const nodes = this.nodes
    let state = 0
    // 记录每个起点上满足边界规则的最长 term
    for (let index = 0; index < source.length; index += 1) {
      const char = source.charCodeAt(index)
      const end = index + 1
      let next = nodes[state].next.get(char)
      while (next === undefined && state) { state = nodes[state].fail; next = nodes[state].next.get(char) }
      state = next ?? 0
      const out = nodes[state].out
      for (let k = 0; k < out.length; k += 1) {
        const length = out[k]
        const from = end - length
        if (length <= best[from]) continue
        if (isAlnumCode(source.charCodeAt(from)) && isAlnumCode(source.charCodeAt(from - 1))) continue
        if (isAlnumCode(source.charCodeAt(end - 1)) && isAlnumCode(source.charCodeAt(end))) continue
        best[from] = length
      }
    }
    const hits: NameHit[] = []
    for (let from = 0; from < source.length;) {
      const length = best[from]
      if (!length) { from += 1; continue }
      const owner = this.owners.get(source.slice(from, from + length))!
      hits.push({ from, to: from + length, term: owner.term, characterIds: [...owner.characterIds] })
      from += length
    }
    return hits
  }
}

/** 「本章提及」：用同一匹配器判断哪些条目在文本中有命中（最长优先、单字默认不算）。 */
export const mentionedIds = (entries: ReadonlyArray<{ id: string; names: readonly string[] }>, text: string, options: NameMatcherOptions = {}): Set<string> => {
  const matcher = new NameMatcher(entries.flatMap((entry) => entry.names.map((term, index) => ({ term, characterId: entry.id, kind: index === 0 ? 'name' as const : 'alias' as const }))), options)
  return new Set(matcher.match(text).flatMap((hit) => hit.characterIds))
}
