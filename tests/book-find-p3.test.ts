import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Node as PmNode } from '@tiptap/pm/model'
import { BOOK_FIND_LIMIT, bookFindSummary, searchBook, type BookFindProgress } from '../src/renderer/src/services/book-find'
import { findMatches } from '../src/renderer/src/services/find-replace'

const schema = getSchema([StarterKit])
const docJson = (paragraphs: Array<string | Array<{ text: string; bold?: boolean }>>): Record<string, unknown> => ({ type: 'doc', content: paragraphs.map((p) => ({ type: 'paragraph',
  content: (typeof p === 'string' ? [{ text: p }] : p).filter((t) => t.text).map((t) => ({ type: 'text', text: t.text, ...('bold' in t && t.bold ? { marks: [{ type: 'bold' }] } : {}) })) })) })
const run = async (books: Record<string, Record<string, unknown>>, query: string, options = { caseSensitive: false, regex: false }, extra: { limit?: number; batch?: number; sliceMs?: number; cancelAfter?: number } = {}) => {
  const chapters = Object.keys(books).map((id) => ({ id, title: `章 ${id}` }))
  const updates: BookFindProgress[] = []
  let loads = 0
  const final = await searchBook({ chapters, schema, query, options, limit: extra.limit, batch: extra.batch ?? 2, sliceMs: extra.sliceMs,
    load: async (ids) => { loads += 1; return ids.map((id) => books[id]) }, onProgress: (p) => updates.push(p), isCancelled: () => extra.cancelAfter !== undefined && loads > extra.cancelAfter })
  return { final, updates, loads }
}

describe('P3 全书查找（只查找）', () => {
  it('按章分组、按章节顺序；无命中的章不出现；逐章与章内查找 findMatches 结果一致', async () => {
    const books = { a: docJson(['林舟来了。', '林舟走了。']), b: docJson(['无关']), c: docJson([[{ text: '前' }, { text: '林', bold: true }, { text: '舟后' }]]) }
    const { final, updates } = await run(books, '林舟')
    expect(final.done).toBe(true)
    expect(final.groups.map((g) => [g.documentId, g.count])).toEqual([['a', 2], ['c', 1]])
    for (const group of final.groups) expect(group.hits).toEqual(findMatches(PmNode.fromJSON(schema, books[group.documentId as 'a']), '林舟', { caseSensitive: false, regex: false }).matches.map((m) => ({ from: m.from, to: m.to })))
    expect(final.groups[1].excerpts[0]).toMatchObject({ before: '前', text: '林舟', after: '后' })
    expect(updates.length).toBeGreaterThan(1)
    expect(bookFindSummary(final)).toBe('2 章 · 共 3 处')
  })

  it('区分大小写 / 正则复用 PR-1；正则错误给出提示不抛错；空查询无结果', async () => {
    const books = { a: docJson(['Lin lin LIN']) }
    expect((await run(books, 'lin')).final.hits).toBe(3)
    expect((await run(books, 'lin', { caseSensitive: true, regex: false })).final.hits).toBe(1)
    expect((await run(books, 'l.n', { caseSensitive: false, regex: true })).final.hits).toBe(3)
    const bad = (await run(books, '(', { caseSensitive: false, regex: true })).final
    expect(bad.error).toBeTruthy(); expect(bad.groups).toEqual([])
    expect((await run(books, '')).final.hits).toBe(0)
  })

  it('总上限：超出即截断、停止后续章节，并提示「请缩小查找范围」；恰好等于上限不算截断', async () => {
    const books = { a: docJson(['甲甲甲']), b: docJson(['甲甲']), c: docJson(['甲']) }
    const over = (await run(books, '甲', undefined, { limit: 4 })).final
    expect(over.truncated).toBe(true); expect(over.hits).toBe(4)
    expect(over.groups.map((g) => g.count)).toEqual([3, 1])
    expect(bookFindSummary(over)).toContain('请缩小查找范围')
    const exact = (await run({ a: docJson(['甲甲甲']), b: docJson(['乙']) }, '甲', undefined, { limit: 3 })).final
    expect(exact.truncated).toBe(false); expect(exact.hits).toBe(3)
    expect(BOOK_FIND_LIMIT).toBe(100_000)
  })

  it('分批读取并可取消：取消后不再读取后续批次', async () => {
    const books = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, docJson(['甲'])]))
    const all = await run(books, '甲', undefined, { batch: 3 })
    expect(all.loads).toBe(4); expect(all.final.hits).toBe(10)
    const cancelled = await run(books, '甲', undefined, { batch: 3, cancelAfter: 1 })
    expect(cancelled.loads).toBe(2); expect(cancelled.final.done).toBe(false)
  })
})
