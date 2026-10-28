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
}

export const toContextSourceRows = (bundle: ContextBundle): ContextSourceRow[] => [
  ...bundle.items.map((item) => ({ id: item.id, kind: item.kind, title: item.title, reason: item.reason,
    preview: item.content.replace(/\s+/g, ' ').slice(0, 90), included: true, truncated: Boolean(item.truncated) })),
  ...(bundle.metadata.omitted ?? []).map((item) => ({ id: item.id, kind: item.kind, title: item.title, reason: '',
    preview: '', included: false, truncated: false, omittedReason: item.reason }))
]

export const toggleExcludedId = (excluded: string[], id: string): string[] =>
  excluded.includes(id) ? excluded.filter((item) => item !== id) : [...excluded, id]

export const toggleIncludedId = (included: string[], id: string): string[] =>
  included.includes(id) ? included.filter((item) => item !== id) : [...included, id]

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
