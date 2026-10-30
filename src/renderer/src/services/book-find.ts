import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { Node as PmNode } from '@tiptap/pm/model'
import { buildFindRegExp, findMatches, type FindOptions } from './find-replace'

/**
 * 全书查找（P3 PR-2a，只查找）：在 renderer 逐章跑 PR-1 的 findMatches，语义与章内查找完全一致。
 * 按章分批读取并让出主线程；总命中上限 BOOK_FIND_LIMIT，超出即截断。纯本地，无网络、无 AI。
 */
export const BOOK_FIND_LIMIT = 100_000
export const BOOK_FIND_BATCH = 20
/** 单段连续计算的预算；超出就让出主线程（setTimeout 0），保证搜索期间没有长任务。 */
export const BOOK_FIND_SLICE_MS = 12
export const EXCERPT_PER_CHAPTER = 3
const EXCERPT_CONTEXT = 18

export interface BookHit { from: number; to: number }
export interface BookExcerpt { before: string; text: string; after: string; from: number }
export interface BookFindGroup { documentId: string; title: string; count: number; hits: BookHit[]; excerpts: BookExcerpt[] }
export interface BookFindProgress { groups: BookFindGroup[]; scanned: number; total: number; hits: number; truncated: boolean; done: boolean; error?: string }
export interface BookChapterRef { id: string; title: string }

export function excerptAt(doc: ProseMirrorNode, from: number, to: number): BookExcerpt {
  const $from = doc.resolve(from)
  const start = $from.start(); const end = $from.end()
  const flat = (a: number, b: number): string => doc.textBetween(a, b, undefined, ' ').replace(/\s+/g, ' ')
  return { before: flat(Math.max(start, from - EXCERPT_CONTEXT), from), text: flat(from, to), after: flat(to, Math.min(end, to + EXCERPT_CONTEXT)), from }
}

/** 单章：返回本章命中（至多 remaining 处）和是否被截断。 */
export function findInChapter(doc: ProseMirrorNode, ref: BookChapterRef, query: string, options: FindOptions, remaining: number): { group?: BookFindGroup; truncated: boolean } {
  const result = findMatches(doc, query, options, remaining)
  if (!result.matches.length) return { truncated: result.truncated }
  const hits = result.matches.map((match) => ({ from: match.from, to: match.to }))
  return { truncated: result.truncated, group: { documentId: ref.id, title: ref.title, count: hits.length, hits,
    excerpts: hits.slice(0, EXCERPT_PER_CHAPTER).map((hit) => excerptAt(doc, hit.from, hit.to)) } }
}

const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * 按章节顺序搜索全书。load 每次取一批章节的 editorJson；每批、每超出时间片就让出主线程并回调 onProgress。
 * isCancelled 返回 true 时尽快停止（查询词或选项变化）。
 */
export async function searchBook(input: {
  chapters: BookChapterRef[]; schema: Schema; query: string; options: FindOptions
  load(ids: string[]): Promise<Array<Record<string, unknown>>>
  onProgress(progress: BookFindProgress): void; isCancelled(): boolean
  limit?: number; batch?: number; sliceMs?: number
}): Promise<BookFindProgress> {
  const { chapters, schema, query, options, load, onProgress, isCancelled } = input
  const limit = input.limit ?? BOOK_FIND_LIMIT; const batch = input.batch ?? BOOK_FIND_BATCH; const sliceMs = input.sliceMs ?? BOOK_FIND_SLICE_MS
  const progress: BookFindProgress = { groups: [], scanned: 0, total: chapters.length, hits: 0, truncated: false, done: false }
  const { error } = buildFindRegExp(query, options)
  if (error || !query) { const final = { ...progress, done: true, error }; onProgress(final); return final }
  for (let offset = 0; offset < chapters.length && !progress.truncated; offset += batch) {
    const refs = chapters.slice(offset, offset + batch)
    const docs = await load(refs.map((ref) => ref.id))
    if (isCancelled()) return progress
    let sliceStart = now()
    for (let i = 0; i < refs.length; i += 1) {
      const doc = PmNode.fromJSON(schema, docs[i])
      const { group, truncated } = findInChapter(doc, refs[i], query, options, limit - progress.hits)
      progress.scanned += 1
      if (group) { progress.groups.push(group); progress.hits += group.count }
      if (truncated) { progress.truncated = true; break }
      if (now() - sliceStart > sliceMs) {
        onProgress({ ...progress, groups: [...progress.groups] })
        await yieldToMain()
        if (isCancelled()) return progress
        sliceStart = now()
      }
    }
    onProgress({ ...progress, groups: [...progress.groups] })
    await yieldToMain()
    if (isCancelled()) return progress
  }
  const final = { ...progress, groups: [...progress.groups], done: true }
  onProgress(final)
  return final
}

export const bookFindSummary = (progress: BookFindProgress): string => {
  if (progress.error) return progress.error
  const head = `${progress.groups.length} 章 · 共 ${progress.hits.toLocaleString()} 处`
  if (progress.truncated) return `${head}（已达上限 ${BOOK_FIND_LIMIT.toLocaleString()} 处，结果已截断，请缩小查找范围）`
  if (!progress.done) return `${head} · 已查 ${progress.scanned} / ${progress.total} 章…`
  return progress.hits ? head : '无匹配'
}
