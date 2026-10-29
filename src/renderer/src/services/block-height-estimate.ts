/**
 * 屏外段落（content-visibility:auto）在首次渲染前的估算高度。
 * 估算越接近真实段高，滚动条总长度越稳定（渲染后浏览器以 `auto` 记住真实高度）。
 * 只在打开章节、宽度变化和停顿后计算，不在按键路径上。
 */
export interface BlockMetrics {
  /** 正文区可用宽度（px） */
  contentWidth: number
  /** 一个汉字（含字间距）宽度（px） */
  cjkWidth: number
  /** 非汉字字符的平均宽度（px） */
  latinWidth: number
  lineHeight: number
  /** 首行缩进（px） */
  indent: number
}

const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u3000-\u303f]/

/** 一段文字的行数（汉字按字断行；至少 1 行，空段也占 1 行）。 */
export const estimateLines = (text: string, metrics: BlockMetrics): number => {
  if (metrics.contentWidth <= 0 || metrics.cjkWidth <= 0) return 1
  let lines = 1
  let x = metrics.indent
  for (const char of text) {
    const width = WIDE.test(char) ? metrics.cjkWidth : metrics.latinWidth
    if (x + width > metrics.contentWidth + 0.5 && x > 0) { lines += 1; x = 0 }
    x += width
  }
  return lines
}

/**
 * 全章段落的平均估算高度（px，不含外边距：contain-intrinsic-size 只替代内容盒高度，段后距照常计入）。
 * 各段不同长时整体总高仍与真实值接近。
 */
export const averageBlockHeight = (texts: readonly string[], metrics: BlockMetrics): number => {
  if (texts.length === 0) return metrics.lineHeight
  let total = 0
  for (const text of texts) total += estimateLines(text, metrics) * metrics.lineHeight
  return total / texts.length
}
