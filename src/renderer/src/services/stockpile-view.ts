import type { StockpileSummary } from '../../../shared/domain'

/** 仅当 daysRemaining 为非 null 数字时渲染可撑天数；未设章数目标 → 不渲染、无「存稿不足」提示。 */
export function shouldShowStockpileDays(summary: Pick<StockpileSummary, 'daysRemaining'>): boolean {
  return typeof summary.daysRemaining === 'number' && Number.isFinite(summary.daysRemaining)
}
