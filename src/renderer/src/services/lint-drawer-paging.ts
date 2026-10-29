/** 校对抽屉分页与批量应用上限（L2）：命中上万条时只渲染前若干条，批量提案单次有上限。 */
export const LINT_PAGE_SIZE = 200
export const BATCH_PROPOSE_LIMIT = 500

/** 按分组顺序截取前 limit 条，保留每组的总数，便于界面同时显示「已显示 / 总数」。 */
export const pageLintGroups = <T>(groups: Array<{ group: string; issues: T[] }>, limit: number): Array<{ group: string; total: number; issues: T[] }> => {
  let remaining = Math.max(0, limit)
  const paged: Array<{ group: string; total: number; issues: T[] }> = []
  for (const { group, issues } of groups) {
    if (remaining === 0) break
    const shown = issues.slice(0, remaining)
    remaining -= shown.length
    paged.push({ group, total: issues.length, issues: shown })
  }
  return paged
}

/** 批量应用的本次范围：超过上限时只取前 limit 处，并返回剩余数量供界面明确提示（不静默截断）。 */
export const batchSlice = <T>(items: T[], limit = BATCH_PROPOSE_LIMIT): { items: T[]; total: number; remaining: number } =>
  ({ items: items.slice(0, limit), total: items.length, remaining: Math.max(0, items.length - limit) })
