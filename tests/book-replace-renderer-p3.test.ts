import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Node as PmNode } from '@tiptap/pm/model'
import { docPlainText, prepareBookReplace } from '../src/renderer/src/services/book-find'

// P3 PR-2b：renderer 侧准备全书替换（按库里最新内容逐章重算，复用 PR-1 findMatches + applyReplacements）
const schema = getSchema([StarterKit])
const para = (...texts: Array<{ text: string; bold?: boolean } | { hardBreak: true }>) => ({ type: 'paragraph', content: texts.map((t) => 'hardBreak' in t ? { type: 'hardBreak' } : { type: 'text', text: t.text, ...(t.bold ? { marks: [{ type: 'bold' }] } : {}) }) })
const book: Record<string, { editorJson: Record<string, unknown>; revision: number }> = {
  a: { revision: 3, editorJson: { type: 'doc', content: [para({ text: '远处灯亮。远处灯灭。' }), para({ text: '远' }, { text: '处灯', bold: true }, { hardBreak: true }, { text: '尾' })] } },
  b: { revision: 1, editorJson: { type: 'doc', content: [para({ text: '无关' })] } },
  c: { revision: 7, editorJson: { type: 'doc', content: [para({ text: 'Abc abc ABC' })] } }
}
const load = async (ids: string[]) => ids.map((id) => book[id])

describe('prepareBookReplace', () => {
  it('逐章替换（含跨格式命中），带各章当前 revision；无命中的章不提交', async () => {
    const plan = await prepareBookReplace({ chapterIds: ['a', 'b'], schema, query: '远处灯', replacement: '远处星', options: { caseSensitive: false, regex: false }, load, batch: 1 })
    expect(plan.truncated).toBe(false); expect(plan.hits).toBe(3)
    expect(plan.items.map((item) => [item.documentId, item.expectedRevision, item.hits])).toEqual([['a', 3, 3]])
    const doc = PmNode.fromJSON(schema, plan.items[0].editorJson)
    expect(doc.textContent).not.toContain('远处灯')
    expect(plan.items[0].plainText).toBe(docPlainText(doc))
  })
  it('plainText 与编辑器保存规则一致：段间 \\n\\n，hardBreak 按其 renderText 记作 \\n', () => {
    expect(docPlainText(PmNode.fromJSON(schema, book.a.editorJson))).toBe('远处灯亮。远处灯灭。\n\n远处灯\n尾')
  })
  it('区分大小写 / 正则 $1；正则错误不产生任何替换', async () => {
    const cs = await prepareBookReplace({ chapterIds: ['c'], schema, query: 'abc', replacement: 'x', options: { caseSensitive: true, regex: false }, load })
    expect(cs.items[0].plainText).toBe('Abc x ABC')
    const re = await prepareBookReplace({ chapterIds: ['c'], schema, query: '(a)bc', replacement: '[$1]', options: { caseSensitive: false, regex: true }, load })
    expect(re.items[0].plainText).toBe('[A] [a] [A]')
    const bad = await prepareBookReplace({ chapterIds: ['c'], schema, query: '(', replacement: 'x', options: { caseSensitive: false, regex: true }, load })
    expect(bad.items).toEqual([]); expect(bad.error).toBeTruthy()
  })
  it('超过上限即 truncated，不返回任何替换项（调用方禁止替换）；恰好等于上限仍可替换', async () => {
    const over = await prepareBookReplace({ chapterIds: ['a', 'c'], schema, query: '远处灯', replacement: 'x', options: { caseSensitive: false, regex: false }, load, limit: 2 })
    expect(over.truncated).toBe(true); expect(over.items).toEqual([])
    const exact = await prepareBookReplace({ chapterIds: ['a'], schema, query: '远处灯', replacement: 'x', options: { caseSensitive: false, regex: false }, load, limit: 3 })
    expect(exact.truncated).toBe(false); expect(exact.hits).toBe(3)
  })
})
