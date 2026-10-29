/**
 * P1-5 读者视角审稿：作者指定「读到第 N 章」（按章树顺序，1 起）。
 * N 必须是 1..总章数 内的整数；否则给出中文可读错误，不做任何猜测或截断。
 */
export const validateReaderChapterNumber = (n: unknown, total: number): { ok: true; index: number } | { ok: false; error: string } => {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: '「读到第 N 章」必须是整数。' }
  if (n < 1) return { ok: false, error: '「读到第 N 章」至少为 1。' }
  if (total < 1) return { ok: false, error: '作品还没有章节，无法进行读者审稿。' }
  if (n > total) return { ok: false, error: `「读到第 N 章」超出范围：当前共 ${total} 章。` }
  return { ok: true, index: n - 1 }
}

export const READER_REVIEW_DEFAULT_INTENT = (n: number): string =>
  `我是读到第 ${n} 章的普通读者。请给出只读审稿报告：读者疑问、追读风险，每条注明具体章节。`
