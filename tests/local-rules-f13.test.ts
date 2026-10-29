import { describe, expect, it } from 'vitest'
import { compileWordlist, DEFAULT_LINT_RULES, lintProject, LONG_CHAPTER_CHARS } from '../src/main/services/local-rules'
import { lintChineseText } from '../src/main/services/local-linter'
import type { LintRules } from '../src/shared/domain'

const run = (text: string, options: { global?: string; project?: string; rules?: Partial<LintRules> } = {}) =>
  lintProject({ text, documentId: 'd', sourceRevision: 1, globalText: options.global ?? '', projectText: options.project ?? '', rules: { ...DEFAULT_LINT_RULES, ...options.rules } })
const strip = (issues: Array<Record<string, unknown>>) => issues.map(({ id: _drop, ...rest }) => { void _drop; return rest })

describe('F13 ③ 词表最长优先 / 匹配语义', () => {
  it('「在坐」「在坐席」同时存在时，「在坐席上」只命中「在坐席」', () => {
    const { issues } = run('他在坐席上', { global: '在坐=>在座\n在坐席=>在座席' })
    expect(issues.map((issue) => [issue.originalText, issue.replacement, issue.group])).toEqual([['在坐席', '在座席', 'wordlist_replace']])
  })
  it('中文按子串；纯 ASCII 字母数字要求词边界（cat 不命中 category，与 F14 一致）', () => {
    const { issues } = run('一只cat和category，还有猫咪', { global: 'cat\n猫' })
    expect(issues.map((issue) => [issue.from, issue.originalText])).toEqual([[2, 'cat'], [17, '猫']])
  })
  it('提示类无替换；单字词条也参与；作品级 ! 关掉全局词', () => {
    const { issues } = run('在坐的人', { global: '在坐=>在座\n人', project: '!在坐' })
    expect(issues.map((issue) => [issue.originalText, issue.replacement, issue.ruleKey])).toEqual([['人', undefined, 'wordlist:人']])
  })
  it('词表关闭时一条都不报；匹配器按词表缓存（同一词表不重建）', () => {
    expect(run('在坐', { global: '在坐=>在座', rules: { wordlist: false } }).issues).toEqual([])
    expect(compileWordlist('甲=>乙', '')).toBe(compileWordlist('甲=>乙', ''))
    expect(compileWordlist('甲=>乙', '')).not.toBe(compileWordlist('甲=>丙', ''))
  })
})

describe('F13 ④ 重复字', () => {
  const rules = { repeatChar: true, repeatChars: ['的', '看', '渐'] }
  it('只报勾选字的紧邻重复；白名单「渐渐」「看看」不报', () => {
    const { issues } = run('我的的书，渐渐地看看，了了', { rules })
    expect(issues.map((issue) => [issue.originalText, issue.replacement, issue.group])).toEqual([['的的', '的', 'repeat_char']])
  })
  it('默认关闭：一条都不报', () => { expect(run('的的的', { rules: { repeatChars: ['的'] } }).issues).toEqual([]) })
})

describe('F13 ⑤ 全半角', () => {
  it('「你好,世界」报出；「a,b」「你好,a」不报', () => {
    expect(run('你好,世界').issues.map((issue) => [issue.originalText, issue.replacement])).toEqual([[',', '，']])
    expect(run('a,b').issues).toEqual([])
    expect(run('你好,a').issues).toEqual([])
    expect(run('他(笑)说').issues.map((issue) => issue.replacement)).toEqual(['（', '）'])
  })
})

describe('F13 ⑥ 回归：只开标点规则时与 lintChineseText 一致', () => {
  it('新规则全部关闭 → 输出 = lintChineseText（去掉 id 与新增字段）', () => {
    const text = '他说..你好 世界。。“没有闭合！！—'
    const off = run(text, { global: '你好', rules: { wordlist: false, halfwidth: false, repeatChar: false } }).issues
    expect(strip(off.map(({ ruleKey: _r, group: _g, ...rest }) => { void _r; void _g; return rest }))).toEqual(strip(lintChineseText(text, 'd', 1) as never))
  })
  it('超过 20 万字只跑标点规则并返回 longChapter', () => {
    const result = run(`${'在坐'.repeat(LONG_CHAPTER_CHARS / 2)}..你好,世界`, { global: '在坐=>在座' })
    expect(result.longChapter).toBe(true)
    expect(result.issues.every((issue) => issue.group === 'punctuation')).toBe(true)
    expect(result.issues.length).toBeGreaterThan(0)
  })
})

describe('F13 ⑦ 性能', () => {
  it('20 万字 + 20000 条词表（匹配器已缓存）≤ 100ms（CI 放宽 300ms）', () => {
    const terms = Array.from({ length: 20_000 }, (_, i) => `词${String.fromCharCode(0x4e00 + (i % 5000))}${String.fromCharCode(0x4e00 + Math.floor(i / 5000))}=>替${i}`)
    const global = terms.join('\n')
    const base = '风雨如晦，鸡鸣不已。既见君子，云胡不喜。他在坐席上说，词一一很好,但是的的确确。'
    const text = base.repeat(Math.ceil(200_000 / base.length)).slice(0, 200_000)
    const rules = { repeatChar: true, repeatChars: ['的', '了', '是', '在'] }
    run(text, { global, rules })
    const samples = Array.from({ length: 5 }, () => { const start = performance.now(); run(text, { global, rules }); return performance.now() - start }).sort((a, b) => a - b)
    const median = samples[2]
    process.stdout.write(`F13 lint 200k chars + 20000 terms: median ${median.toFixed(1)}ms (samples ${samples.map((value) => value.toFixed(1)).join(', ')})\n`)
    expect(median).toBeLessThanOrEqual(process.env.CI ? 300 : 100)
  })
})
