import type { DocumentNode, NodeOutline } from '../../../shared/domain'

/** 大纲视图卡片：顺序与章树同源（卷 → 其下章）。 */
export type OutlineCard = {
  nodeId: string
  type: 'volume' | 'chapter'
  title: string
  summary: string
  beats: string[]
  hook: string
}

/** 从章树 + 细纲表构建卡片列表（仅 volume/chapter）。 */
export const buildOutlineCards = (tree: DocumentNode[], outlines: NodeOutline[]): OutlineCard[] => {
  const byNode = new Map(outlines.map((item) => [item.nodeId, item]))
  const cards: OutlineCard[] = []
  const volumes = tree.filter((node) => node.type === 'volume').sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt)
  for (const volume of volumes) {
    const volOutline = byNode.get(volume.id)
    cards.push({
      nodeId: volume.id, type: 'volume', title: volume.title,
      summary: volOutline?.summary ?? '', beats: volOutline?.beats ?? [], hook: volOutline?.hook ?? ''
    })
    const chapters = tree
      .filter((node) => node.type === 'chapter' && node.parentId === volume.id)
      .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt)
    for (const chapter of chapters) {
      const outline = byNode.get(chapter.id)
      cards.push({
        nodeId: chapter.id, type: 'chapter', title: chapter.title,
        summary: outline?.summary ?? '', beats: outline?.beats ?? [], hook: outline?.hook ?? ''
      })
    }
  }
  return cards
}

/** 批量建章：按行拆分细纲，去掉空行。 */
export const parseBatchOutlineLines = (text: string): string[] =>
  text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)

/** 批量建章默认章名：第 N 章（N 从已有章数 + 1 起）。 */
export const batchChapterTitle = (existingChapterCount: number, indexInBatch: number): string =>
  `第${existingChapterCount + indexInBatch + 1}章`

/** 侧栏/卡片展示用的细纲摘要文案。 */
export const outlinePreviewText = (card: Pick<OutlineCard, 'summary' | 'beats' | 'hook'>): string => {
  const parts = [
    card.summary.trim(),
    ...card.beats.map((beat) => beat.trim()).filter(Boolean),
    card.hook.trim() ? `钩子：${card.hook.trim()}` : ''
  ].filter(Boolean)
  return parts.join(' · ')
}
