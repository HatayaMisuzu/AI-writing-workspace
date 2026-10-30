import type { DocumentNode } from '../../../shared/domain'

/** 重命名等操作刷新目录树后，把当前打开节点的标题同步成树里的最新值（id 不变时才同步；无变化返回原对象，避免多余重渲染）。 */
export const syncSelectedTitle = (selected: DocumentNode | undefined, tree: readonly DocumentNode[]): DocumentNode | undefined => {
  if (!selected) return selected
  const fresh = tree.find((node) => node.id === selected.id)
  return fresh && fresh.title !== selected.title ? { ...selected, title: fresh.title } : selected
}
