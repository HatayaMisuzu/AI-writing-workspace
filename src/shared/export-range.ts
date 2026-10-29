/**
 * P1-2 F12：导出章节筛选。range 为章树顺序下的 1 起始章序号（含两端），
 * 先按范围截取，再与 S11「仅定稿」组合过滤；输出保持章树顺序。
 */
export type ExportChapterRange = { from: number; to: number }
export type ManuscriptExportResult = { status: 'saved'; filePath: string } | { status: 'canceled' } | { status: 'empty' }
export type ExportOptions = { onlyFinal?: boolean; range?: ExportChapterRange }

export function validateExportRange(range: ExportChapterRange, total: number): void {
  const { from, to } = range
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error('章节范围须为整数')
  if (from > to) throw new Error(`起始章 ${from} 不能大于结束章 ${to}`)
  if (from < 1 || to > total) throw new Error(`章节范围超出 1–${total}`)
}

export function selectExportChapters<T extends { status: string }>(chapters: T[], options: ExportOptions = {}): T[] {
  let selected = chapters
  if (options.range) {
    validateExportRange(options.range, chapters.length)
    selected = chapters.slice(options.range.from - 1, options.range.to)
  }
  return options.onlyFinal ? selected.filter((chapter) => chapter.status === 'final') : selected
}
