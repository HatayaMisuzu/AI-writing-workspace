import { describe, expect, it } from 'vitest'
import { averageBlockHeight, estimateLines, type BlockMetrics } from '../src/renderer/src/services/block-height-estimate'

const metrics: BlockMetrics = { contentWidth: 360, cjkWidth: 18, latinWidth: 9, lineHeight: 34, indent: 36 }

describe('M-1 屏外段落估算高度', () => {
  it('汉字按字断行，首行缩进占位；空段 1 行', () => {
    expect(estimateLines('', metrics)).toBe(1)
    expect(estimateLines('字'.repeat(18), metrics)).toBe(1) // 36 + 18×18 = 360
    expect(estimateLines('字'.repeat(19), metrics)).toBe(2)
    expect(estimateLines('字'.repeat(18 + 20 * 3), metrics)).toBe(4)
    expect(estimateLines('a'.repeat(36), metrics)).toBe(1)
    expect(estimateLines('a'.repeat(37), metrics)).toBe(2)
  })
  it('平均段高 = 各段行数 × 行高的均值（不含段后距）', () => {
    expect(averageBlockHeight(['字', '字'.repeat(19)], metrics)).toBe((34 + 68) / 2)
    expect(averageBlockHeight([], metrics)).toBe(34)
  })
  it('宽度为 0 时退化为 1 行', () => {
    expect(estimateLines('字'.repeat(100), { ...metrics, contentWidth: 0 })).toBe(1)
  })
})
