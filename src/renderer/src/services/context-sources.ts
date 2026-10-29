import type { ContextBundle, ContextItem, ContextOmission } from '../../../shared/domain'

/** 上下文清单中的一行：已发送（included）或未发送（omitted，含原因）。 */
export interface ContextSourceRow {
  id: string
  kind: ContextItem['kind']
  title: string
  reason: string
  preview: string
  included: boolean
  truncated: boolean
  /** S7 “已省略”标注接口：user_excluded = 作者排除；budget = 超出预算；default_excluded = 默认不带（如大纲）。 */
  omittedReason?: ContextOmission['reason']
  /** P3-e：入选/省略依据标签，如「钉住」「已确认」「本章提及」「预算不足省略」。 */
  basis?: string[]
}

/** P3-e：可被作者钉住的同类设定（钉住 = 加入 includedIds，排序永远最前）。 */
export const PINNABLE_KINDS: ReadonlyArray<ContextItem['kind']> = ['memory', 'character', 'timeline']
export const isPinnable = (row: Pick<ContextSourceRow, 'kind'>): boolean => PINNABLE_KINDS.includes(row.kind)

const omittedBasis = (item: ContextOmission): string[] =>
  item.basis ? [...item.basis, ...(item.reason === 'budget' ? ['预算不足省略'] : [])] : []

export const toContextSourceRows = (bundle: ContextBundle): ContextSourceRow[] => [
  ...bundle.items.map((item) => ({ id: item.id, kind: item.kind, title: item.title, reason: item.reason,
    preview: item.content.replace(/\s+/g, ' ').slice(0, 90), included: true, truncated: Boolean(item.truncated), basis: item.basis ?? [] })),
  ...(bundle.metadata.omitted ?? []).map((item) => ({ id: item.id, kind: item.kind, title: item.title, reason: '',
    preview: '', included: false, truncated: false, omittedReason: item.reason, basis: omittedBasis(item) }))
]

export const toggleExcludedId = (excluded: string[], id: string): string[] =>
  excluded.includes(id) ? excluded.filter((item) => item !== id) : [...excluded, id]

export const toggleIncludedId = (included: string[], id: string): string[] =>
  included.includes(id) ? included.filter((item) => item !== id) : [...included, id]

export const basisLabel = (row: Pick<ContextSourceRow, 'basis'>): string => (row.basis ?? []).join(' · ')

/** 大纲等默认不发送的条目：勾选 = 加入 includedIds；其余：勾选 = 不在 excludedIds。 */
export const isRowChecked = (row: ContextSourceRow, excludedIds: string[], includedIds: string[]): boolean =>
  row.kind === 'outline' || row.omittedReason === 'default_excluded'
    ? includedIds.includes(row.id)
    : !excludedIds.includes(row.id)

export const omittedLabel = (reason?: ContextOmission['reason']): string =>
  reason === 'user_excluded' ? '已排除'
    : reason === 'budget' ? '已省略（超出预算）'
    : reason === 'default_excluded' ? '默认不发送（勾选后带上）'
    : ''

/** 大纲条目的 id 前缀（勾选大纲 = includedIds 中的大纲 id；其余 includedIds 为钉住的设定）。 */
export const isOutlineSourceId = (id: string): boolean => id.startsWith('outline:') || id.startsWith('outline-note:')
export const pinnedIdsOf = (includedIds: string[]): string[] => includedIds.filter((id) => !isOutlineSourceId(id))
export const PIN_SCOPE_HINT = '钉住仅在本次对话有效'

/** P3-e M2：请求完成后排除项与勾选大纲照旧清空，钉住在本次对话内保留（不持久化）。 */
export const stateAfterRequest = (state: { excludedIds: string[]; includedIds: string[] }): { excludedIds: string[]; includedIds: string[] } =>
  ({ excludedIds: [], includedIds: pinnedIdsOf(state.includedIds) })

/** 上下文按钮计数：排除 / 勾选大纲 / 钉住 分开显示，只列非零项。 */
export const contextButtonLabel = (excludedIds: string[], includedIds: string[]): string => {
  const pinned = pinnedIdsOf(includedIds).length
  const outlines = includedIds.length - pinned
  const parts = [excludedIds.length ? `排除 ${excludedIds.length}` : '', outlines ? `勾选大纲 ${outlines}` : '', pinned ? `钉住 ${pinned}` : ''].filter(Boolean)
  return parts.length ? `上下文（${parts.join('·')}）` : '上下文'
}

/** 切换对话 / 新对话时共用：排除态不持久化，一律清空。 */
export const clearedExclusionState = (): { excludedIds: string[]; includedIds: string[] } =>
  ({ excludedIds: [], includedIds: [] })

