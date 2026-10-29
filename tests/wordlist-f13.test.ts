// F13 词表解析 / 合并 / 导入预览的纯函数单测（不依赖数据库与 Electron）
import { describe, expect, it } from 'vitest'
import { mergeWordlists, parseWordlist, planWordlistImport, serializeWordlist, WORDLIST_LIMITS } from '../src/shared/wordlist'

describe('F13 ① 词表解析', () => {
  it('替换类 / 提示类 / 注释 / 空行 / !禁用 / 格式错误行（报行号）/ 超长词条', () => {
    const long = '字'.repeat(WORDLIST_LIMITS.termChars + 1)
    const text = ['# 注释', '', '在坐=>在座', '  敏感词  ', '!的地', '=>无左', '缺右=>', '!', long, `${long}=>短`, '短=>' + long, '甲=>乙=>丙', 'Ａ=>A', '合法=>合 法'].join('\n')
    const parsed = parseWordlist(text)
    expect(parsed.lines).toEqual([
      { kind: 'replace', term: '在坐', replacement: '在座', line: 3 },
      { kind: 'hint', term: '敏感词', line: 4 },
      { kind: 'disable', term: '的地', line: 5 },
      { kind: 'replace', term: '合法', replacement: '合 法', line: 14 }
    ])
    expect(parsed.errors.map((item) => item.line)).toEqual([6, 7, 8, 9, 10, 11, 12, 13])
    expect(parsed.errors.find((item) => item.line === 9)?.reason).toContain('50')
  })
  it('CRLF、BOM 正常；有错误行时其余行照常解析', () => {
    const parsed = parseWordlist('\uFEFF在坐=>在座\r\n=>坏\r\n提示')
    expect(parsed.lines.map((item) => item.term)).toEqual(['在坐', '提示'])
    expect(parsed.errors).toHaveLength(1)
  })
  it('serialize 与 parse 往返一致', () => {
    const text = '在坐=>在座\n敏感\n!的地\n'
    expect(serializeWordlist(parseWordlist(text).lines)).toBe(text)
    expect(serializeWordlist(parseWordlist(serializeWordlist(parseWordlist(text).lines)).lines)).toBe(text)
  })
})

describe('F13 ② 全局与作品级合并', () => {
  it('作品级覆盖全局；!词 删掉同名全局条目；作品级新增叠加', () => {
    const merged = mergeWordlists('在坐=>在座\n敏感\n象征=>象徵', '在坐=>在座位\n!敏感\n新词')
    expect(merged.get('在坐')).toEqual({ term: '在坐', replacement: '在座位' })
    expect(merged.has('敏感')).toBe(false)
    expect(merged.get('象征')).toEqual({ term: '象征', replacement: '象徵' })
    expect(merged.get('新词')).toEqual({ term: '新词' })
  })
  it('同一层里同一词以最后一行为准；全局层的 ! 无效', () => {
    expect(mergeWordlists('甲=>乙\n甲=>丙\n!丁', '').get('甲')).toEqual({ term: '甲', replacement: '丙' })
  })
})

describe('F13 ⑨ 导入预览计数（纯函数）', () => {
  it('新增 / 覆盖 / 错误行；相同的不计覆盖', () => {
    const plan = planWordlistImport('在坐=>在座\n敏感\n', '在坐=>在座位\n敏感\n新词\n=>坏\n另=>')
    expect({ added: plan.added, overwritten: plan.overwritten, unchanged: plan.unchanged, errors: plan.errors.map((item) => item.line) })
      .toEqual({ added: 1, overwritten: 1, unchanged: 1, errors: [4, 5] })
    expect(plan.nextText).toBe('在坐=>在座位\n敏感\n新词\n')
  })
})
