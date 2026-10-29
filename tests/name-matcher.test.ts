import { describe, expect, it } from 'vitest'
import { NameMatcher, mentionedIds, normalizeWidth, parseHoverTermRefs, termsFromCharacters, type NameTerm } from '../src/shared/name-matcher'

const t = (term: string, characterId: string, kind: 'name' | 'alias' = 'alias'): NameTerm => ({ term, characterId, kind })

describe('F14 name-matcher', () => {
  it('① 林 / 林栀：最长优先，命中不重叠', () => {
    const matcher = new NameMatcher([t('林', 'a', 'name'), t('林栀', 'b', 'name'), t('栀子', 'c')], { enabledSingleTerms: [{ characterId: 'a', term: '林' }] })
    expect(matcher.match('林栀来了')).toEqual([{ from: 0, to: 2, term: '林栀', characterIds: ['b'] }])
    const hits = matcher.match('林栀子林，林栀栀子')
    expect(hits.map((hit) => hit.term)).toEqual(['林栀', '林', '林栀', '栀子'])
    for (let i = 1; i < hits.length; i += 1) expect(hits[i].from).toBeGreaterThanOrEqual(hits[i - 1].to)
  })

  it('② 单字 term 默认不命中；按别名打开后命中（只对该 characterId 生效）', () => {
    expect(new NameMatcher([t('栀', 'a')]).match('栀来了')).toEqual([])
    expect(new NameMatcher([t('栀', 'a')], { enabledSingleTerms: [{ characterId: 'b', term: '栀' }] }).match('栀来了')).toEqual([])
    expect(new NameMatcher([t('栀', 'a')], { enabledSingleTerms: [{ characterId: 'a', term: ' 栀 ' }] }).match('栀来了'))
      .toEqual([{ from: 0, to: 1, term: '栀', characterIds: ['a'] }])
  })

  it('③ 同名人物属于两张卡：同一区间返回两个 characterId', () => {
    const matcher = new NameMatcher(termsFromCharacters([{ id: 'a', name: '周岚', aliases: [] }, { id: 'b', name: '周岚', aliases: ['阿岚'] }]))
    expect(matcher.match('周岚说')).toEqual([{ from: 0, to: 2, term: '周岚', characterIds: ['a', 'b'] }])
  })

  it('④ 英文/数字词要求两侧不是字母数字：Ann 不命中 Anna', () => {
    const matcher = new NameMatcher([t('Ann', 'a', 'name'), t('K9', 'b')])
    expect(matcher.match('Anna and xAnn')).toEqual([])
    expect(matcher.match('Ann走了，Ann。')).toHaveLength(2)
    expect(matcher.match('见到Ann了')).toEqual([{ from: 2, to: 5, term: 'Ann', characterIds: ['a'] }])
    expect(matcher.match('K9 K99 aK9')).toEqual([{ from: 0, to: 2, term: 'K9', characterIds: ['b'] }])
  })

  it('⑤ 全角半角统一后命中；空 term 被忽略；区间是原文下标', () => {
    expect(normalizeWidth('ＡｎｎＡ１　')).toBe('AnnA1 ')
    const matcher = new NameMatcher([t('Ａｎｎ', 'a', 'name'), t('', 'b'), t('   ', 'c'), t('K9', 'd')])
    expect(matcher.termCount).toBe(2)
    expect(matcher.match('是Ann')).toEqual([{ from: 1, to: 4, term: 'Ａｎｎ', characterIds: ['a'] }])
    expect(matcher.match('是Ｋ９呀')).toEqual([{ from: 1, to: 3, term: 'K9', characterIds: ['d'] }])
    expect(matcher.match('Ａｎｎａ')).toEqual([])
  })

  it('⑥ 性能：2000 卡 / 10000 term / 200000 字，全章匹配 ≤ 150ms（CI 断言；目标 50ms）', () => {
    const chars = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方'
    let seed = 7
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    const word = (len: number): string => Array.from({ length: len }, () => chars[rnd(chars.length)]).join('')
    const terms: NameTerm[] = []
    for (let card = 0; card < 2000; card += 1) for (let k = 0; k < 5; k += 1) terms.push(t(word(2 + rnd(3)), `c${card}`, k ? 'alias' : 'name'))
    expect(terms).toHaveLength(10_000)
    const text = Array.from({ length: 200_000 }, () => chars[rnd(chars.length)]).join('')
    const matcher = new NameMatcher(terms)
    matcher.match(text.slice(0, 1000))
    const times: number[] = []
    let hits = 0
    for (let run = 0; run < 5; run += 1) { const start = performance.now(); hits = matcher.match(text).length; times.push(performance.now() - start) }
    const median = times.toSorted((a, b) => a - b)[2]
    process.stdout.write(`[F14 perf] full chapter median ${median.toFixed(1)}ms, hits ${hits}\n`)
    expect(hits).toBeGreaterThan(0)
    expect(median).toBeLessThanOrEqual(150)
    const paragraph = text.slice(0, 2000)
    const start = performance.now(); for (let i = 0; i < 20; i += 1) matcher.match(paragraph)
    expect((performance.now() - start) / 20).toBeLessThanOrEqual(5)
  })

  it('⑦ hoverIgnoredTerms 中的 term 不命中；数据损坏视为空集', () => {
    const terms = [t('林栀', 'a', 'name'), t('阿栀', 'a'), t('阿栀', 'b')]
    const ignored = parseHoverTermRefs([{ characterId: 'a', term: '阿栀' }])
    const matcher = new NameMatcher(terms, { ignoredTerms: ignored })
    expect(matcher.match('阿栀和林栀')).toEqual([{ from: 0, to: 2, term: '阿栀', characterIds: ['b'] }, { from: 3, to: 5, term: '林栀', characterIds: ['a'] }])
    for (const corrupt of [null, 'x', 42, { a: 1 }, [null, 1, 'x', { characterId: 1, term: '阿栀' }, { characterId: 'a', term: '  ' }]]) expect(parseHoverTermRefs(corrupt)).toEqual([])
    expect(parseHoverTermRefs([{ characterId: 'a', term: '阿栀' }, 'bad'])).toEqual([{ characterId: 'a', term: '阿栀' }])
  })

  it('本章提及：单字别名不算，最长优先', () => {
    expect([...mentionedIds([{ id: 'a', names: ['林栀', '栀'] }, { id: 'b', names: ['林栀子'] }], '栀来了，林栀子')]).toEqual(['b'])
  })
})
