/**
 * P3-e：同类设定（设定记忆 / 人物卡 / 时间线等引用）在同一优先级内的确定排序。
 * 规则（依次比较，纯本地字符串匹配，不调模型）：
 *   1. 作者手动钉住（includedIds）永远最前
 *   2. 已确认（confirmed）优先
 *   3. 本章相关：本章正文或当前选区出现条目名或别名
 *   4. 最近更新（updatedAt 降序）
 *   5. id 升序（兜底，保证同输入同输出）
 */
export interface SettingRankInput {
  id: string
  pinned: boolean
  confirmed: boolean
  /** 条目名 + 别名；空串忽略。 */
  names: string[]
  updatedAt: number
}

export interface SettingRank extends SettingRankInput { mentioned: boolean }

export const BASIS_LABELS = { pinned: '钉住', confirmed: '已确认', mentioned: '本章提及', recent: '按最近更新', budget: '预算不足省略' } as const

/** 设定记忆没有独立的名字字段：取正文开头「名字：」中的名字（≤ 20 字）作为条目名。 */
export const memoryEntryNames = (content: string): string[] => {
  const head = content.trim().match(/^([^：:\n，,。；;]{1,20})[：:]/)
  return head ? [head[1].trim()].filter(Boolean) : []
}

export const isMentioned = (names: string[], haystack: string): boolean =>
  names.some((name) => name.trim().length > 0 && haystack.includes(name.trim()))

export const rankSetting = (input: SettingRankInput, haystack: string): SettingRank =>
  ({ ...input, mentioned: isMentioned(input.names, haystack) })

export const compareSettingRank = (a: SettingRank, b: SettingRank): number =>
  Number(b.pinned) - Number(a.pinned)
  || Number(b.confirmed) - Number(a.confirmed)
  || Number(b.mentioned) - Number(a.mentioned)
  || b.updatedAt - a.updatedAt
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 清单 / snapshot 中显示的入选依据（不含「预算不足省略」，那由省略原因追加）。 */
export const settingBasis = (rank: SettingRank): string[] => {
  const basis: string[] = []
  if (rank.pinned) basis.push(BASIS_LABELS.pinned)
  if (rank.confirmed) basis.push(BASIS_LABELS.confirmed)
  if (rank.mentioned) basis.push(BASIS_LABELS.mentioned)
  if (!basis.length) basis.push(BASIS_LABELS.recent)
  return basis
}
