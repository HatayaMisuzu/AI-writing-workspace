// P3 PR-1：章内查找替换（纯函数 + 单步撤销）与本章大纲
import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from '@tiptap/pm/state'
import { closeHistory, history, undo } from '@tiptap/pm/history'
import { BULK_THRESHOLD, applyReplacements, buildFindRegExp, expandReplacement, findCountLabel, findMatches, matchIndexAtOrAfter } from '../src/renderer/src/services/find-replace'
import { chapterHeadings, isSceneSeparator } from '../src/renderer/src/services/chapter-headings'

const schema = getSchema([StarterKit])
const p = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : [])
const h = (level: number, text: string) => schema.node('heading', { level }, [schema.text(text)])
const docOf = (...blocks: ReturnType<typeof p>[]) => schema.node('doc', null, blocks)
const plain = { caseSensitive: false, regex: false }
const seg = '林舟在会上说，他狠狠地看，又狠狠地走了。夜色很深，风也很大，远处灯。'

const replaceAllUndoable = (doc: ReturnType<typeof docOf>, query: string, replacement: string, options = plain) => {
  let state = EditorState.create({ schema, doc, plugins: [history()] })
  const matches = findMatches(state.doc, query, options).matches
  const tr = state.tr
  const count = applyReplacements(tr, matches, replacement, options.regex)
  state = state.apply(closeHistory(tr))
  return { state, count, original: doc }
}

describe('查找', () => {
  it('普通文本转义；默认不区分大小写；区分大小写选项', () => {
    const doc = docOf(p('Lin a.b Lin lin'), p('a*b'))
    expect(findMatches(doc, 'a.b', plain).matches.map((m) => m.text)).toEqual(['a.b'])
    expect(findMatches(doc, 'a*b', plain).matches).toHaveLength(1)
    expect(findMatches(doc, 'lin', plain).matches).toHaveLength(3)
    expect(findMatches(doc, 'lin', { caseSensitive: true, regex: false }).matches).toHaveLength(1)
  })
  it('位置与 PM 文本一致（多段、标题）', () => {
    const doc = docOf(h(2, '第一节 林舟'), p('林舟来了。'), p(''), p('又见林舟'))
    const matches = findMatches(doc, '林舟', plain).matches
    expect(matches).toHaveLength(3)
    for (const match of matches) expect(doc.textBetween(match.from, match.to)).toBe('林舟')
  })
  it('正则错误给出提示不抛出；空匹配跳过', () => {
    const bad = findMatches(docOf(p('abc')), '(a', { caseSensitive: false, regex: true })
    expect(bad.error).toMatch(/^正则有误/)
    expect(bad.matches).toEqual([])
    expect(buildFindRegExp('[', { caseSensitive: true, regex: true }).error).toBeTruthy()
    expect(findMatches(docOf(p('abc')), 'x*', { caseSensitive: false, regex: true }).matches).toEqual([])
  })
  it('19.9 万字单段（会被分块）里的命中位置正确', () => {
    const text = seg.repeat(5852)
    const doc = docOf(p(text))
    const matches = findMatches(doc, '狠狠地', plain).matches
    expect(matches).toHaveLength(5852 * 2)
    expect(doc.textBetween(matches.at(-1)!.from, matches.at(-1)!.to)).toBe('狠狠地')
  })
  it('计数文案与定位', () => {
    expect(findCountLabel(-1, 0, false)).toBe('无匹配')
    expect(findCountLabel(2, 10, false)).toBe('第 3 / 共 10 处')
    const matches = findMatches(docOf(p('ab ab ab')), 'ab', plain).matches
    expect(matchIndexAtOrAfter(matches, matches[1].from)).toBe(1)
    expect(matchIndexAtOrAfter(matches, 999)).toBe(0)
  })
})

describe('替换', () => {
  it('正则替换模板 $1 / $& / $$', () => {
    const [match] = findMatches(docOf(p('林舟说')), '(林)(舟)', { caseSensitive: false, regex: true }).matches
    expect(expandReplacement('$2$1-$&-$$', match, true)).toBe('舟林-林舟-$')
    expect(expandReplacement('$1', match, false)).toBe('$1')
  })
  it('全部替换是一个撤销步，撤销后原文完全恢复（多段）', () => {
    const doc = docOf(...Array.from({ length: 50 }, (_, i) => p(`${i} 林舟走了，林舟又回来。`)))
    const { state, count, original } = replaceAllUndoable(doc, '林舟', '沈砚')
    expect(count).toBe(100)
    expect(state.doc.textContent).not.toContain('林舟')
    let undone = state
    expect(undo(state, (tr) => { undone = state.apply(tr) })).toBe(true)
    expect(undone.doc.eq(original)).toBe(true)
  })
  it('超长单段批量路径：替换 1000+ 处、长度变化、删除为空，撤销一步恢复', () => {
    const text = seg.repeat(600)
    const doc = docOf(p('前一段 狠狠地'), p(text), p('后一段'))
    const { state, count, original } = replaceAllUndoable(doc, '狠狠地', '恶狠狠')
    expect(count).toBe(1201)
    expect(count).toBeGreaterThan(BULK_THRESHOLD)
    expect(state.doc.child(1).textContent).toBe(text.replaceAll('狠狠地', '恶狠狠'))
    expect(state.doc.child(0).textContent).toBe('前一段 恶狠狠')
    let undone = state
    undo(state, (tr) => { undone = state.apply(tr) })
    expect(undone.doc.eq(original)).toBe(true)
    const removed = replaceAllUndoable(doc, '狠狠地', '')
    expect(removed.state.doc.child(1).textContent).toBe(text.replaceAll('狠狠地', ''))
  })
  it('原文已变的命中跳过', () => {
    const doc = docOf(p('ab ab'))
    const matches = findMatches(doc, 'ab', plain).matches
    const state = EditorState.create({ schema, doc })
    const tr = state.tr.insertText('X', matches[1].from, matches[1].from + 1)
    expect(applyReplacements(tr, matches, 'c', false)).toBe(1)
    expect(tr.doc.textContent).toBe('c Xb')
  })
})

describe('本章大纲', () => {
  it('场景分隔识别', () => {
    for (const text of ['***', '＊＊＊', '——', '◇', '◇ ◇ ◇', '* * *', '---', '※']) expect(isSceneSeparator(text)).toBe(true)
    for (const text of ['', '他说——', '**', '-', '第一节', '。。。']) expect(isSceneSeparator(text)).toBe(false)
  })
  it('列出标题与分隔，预览取后文，pos 指向正文', () => {
    const doc = docOf(h(2, '一、夜行'), p('林舟出门时下着雨。'), p('***'), p(''), p('天亮了，他回到旧宅。'), p('◇'))
    const items = chapterHeadings(doc)
    expect(items.map((item) => [item.kind, item.label, item.preview])).toEqual([
      ['heading', '一、夜行', '林舟出门时下着雨。'], ['scene', '***', '天亮了，他回到旧宅。'], ['scene', '◇', ''],
    ])
    expect(doc.resolve(items[0].pos).parent.textContent).toBe('一、夜行')
    expect(doc.resolve(items[1].pos).parentOffset).toBe(0)
  })
  it('超长单段章节不读全文', () => {
    expect(chapterHeadings(docOf(p(seg.repeat(5852))))).toEqual([])
  })
})
