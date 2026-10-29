/**
 * F13 回归：lintChineseText（现有 8 条正则 + 引号检查）的输出用 golden 锁住。
 * golden 在 base 3469fa1 上生成（UPDATE_LINT_GOLDEN=1），之后 F13 不允许改变它；比较前去掉随机 id。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lintChineseText } from '../src/main/services/local-linter'

const GOLDEN = join(__dirname, 'fixtures', 'lint-chinese-golden.json')
const PIECES = ['他说', '。', '..', '...', '....', '。。', '！！', '!!', '？？', '??', '—', '——', '你好 世界', '中  文', '，,', '。.', '：:', '“', '”', '在坐', 'abc', ' ', '\n\n', '……', '的的', '你好,世界', '（括号）', '(半角)', '123', 'Hello...', '；;']
/** 固定种子 LCG，生成可复现语料。 */
function lintCorpus(count = 80): string[] {
  let seed = 20261029
  const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const corpus = PIECES.slice()
  for (let i = corpus.length; i < count; i += 1) corpus.push(Array.from({ length: 3 + rand(12) }, () => PIECES[rand(PIECES.length)]).join(''))
  return corpus
}
const strip = (text: string, index: number): unknown => lintChineseText(text, `doc-${index}`, index).map((issue) => Object.fromEntries(Object.entries(issue).filter(([key]) => key !== 'id')))

describe('lintChineseText golden', () => {
  it('输出与 base 完全一致', () => {
    const actual = lintCorpus().map((text, index) => ({ text, issues: strip(text, index) }))
    if (process.env.UPDATE_LINT_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`)
    expect(actual).toStrictEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')))
    expect(actual.length).toBeGreaterThanOrEqual(50)
    expect(actual.filter((item) => (item.issues as unknown[]).length > 0).length).toBeGreaterThan(30)
  })
})
