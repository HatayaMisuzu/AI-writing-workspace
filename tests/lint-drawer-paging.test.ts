// L2：校对抽屉分页与批量应用上限的纯函数单测
import { describe, expect, it } from 'vitest'
import { BATCH_PROPOSE_LIMIT, LINT_PAGE_SIZE, batchSlice, pageLintGroups } from '../src/renderer/src/services/lint-drawer-paging'

describe('L2 抽屉分页', () => {
  it('跨分组按顺序截取前 limit 条，并保留每组总数', () => {
    const groups = [{ group: 'a', issues: [1, 2, 3] }, { group: 'b', issues: [4, 5] }, { group: 'c', issues: [6] }]
    expect(pageLintGroups(groups, 4)).toEqual([{ group: 'a', total: 3, issues: [1, 2, 3] }, { group: 'b', total: 2, issues: [4] }])
    expect(pageLintGroups(groups, 100).flatMap((item) => item.issues)).toEqual([1, 2, 3, 4, 5, 6])
    expect(pageLintGroups(groups, 0)).toEqual([])
  })
  it('11704 条首屏只渲染 200 条', () => {
    const issues = Array.from({ length: 11704 }, (_, index) => index)
    expect(pageLintGroups([{ group: 'w', issues }], LINT_PAGE_SIZE)[0]).toMatchObject({ total: 11704, issues: { length: 200 } })
  })
})

describe('L2 批量应用上限', () => {
  it('不超过上限时全部应用、剩余 0', () => {
    expect(batchSlice([1, 2, 3])).toEqual({ items: [1, 2, 3], total: 3, remaining: 0 })
  })
  it('超过上限时只取前 500 处并给出剩余数量', () => {
    const result = batchSlice(Array.from({ length: 5852 }, (_, index) => index))
    expect(BATCH_PROPOSE_LIMIT).toBe(500)
    expect(result.items).toHaveLength(500)
    expect(result).toMatchObject({ total: 5852, remaining: 5352 })
  })
})
