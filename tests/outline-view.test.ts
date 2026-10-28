import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import {
  batchChapterTitle,
  buildOutlineCards,
  outlinePreviewText,
  parseBatchOutlineLines
} from '../src/renderer/src/services/outline-view'
import type { DocumentNode, NodeOutline } from '../src/shared/domain'

describe('S4 outline view helpers（组件状态）', () => {
  it('parseBatchOutlineLines 去空行并保序', () => {
    expect(parseBatchOutlineLines('  a\n\n b \n\nc\n')).toEqual(['a', 'b', 'c'])
    expect(parseBatchOutlineLines('')).toEqual([])
  })

  it('buildOutlineCards 顺序与章树同源', () => {
    const tree: DocumentNode[] = [
      { id: 'v2', projectId: 'p', parentId: null, type: 'volume', title: '卷二', orderIndex: 1, wordCount: 0, revision: 0, createdAt: 2, updatedAt: 2 },
      { id: 'v1', projectId: 'p', parentId: null, type: 'volume', title: '卷一', orderIndex: 0, wordCount: 0, revision: 0, createdAt: 1, updatedAt: 1 },
      { id: 'c2', projectId: 'p', parentId: 'v1', type: 'chapter', title: '第二章', orderIndex: 1, wordCount: 0, revision: 0, createdAt: 4, updatedAt: 4 },
      { id: 'c1', projectId: 'p', parentId: 'v1', type: 'chapter', title: '第一章', orderIndex: 0, wordCount: 0, revision: 0, createdAt: 3, updatedAt: 3 },
      { id: 'c3', projectId: 'p', parentId: 'v2', type: 'chapter', title: '第三章', orderIndex: 0, wordCount: 0, revision: 0, createdAt: 5, updatedAt: 5 }
    ]
    const outlines: NodeOutline[] = [
      { nodeId: 'c1', projectId: 'p', summary: '开篇', beats: ['遇雨'], hook: '有人敲门', updatedAt: 1 },
      { nodeId: 'v1', projectId: 'p', summary: '入门', beats: [], hook: '', updatedAt: 1 }
    ]
    const cards = buildOutlineCards(tree, outlines)
    expect(cards.map((card) => card.nodeId)).toEqual(['v1', 'c1', 'c2', 'v2', 'c3'])
    expect(cards[1]).toMatchObject({ title: '第一章', summary: '开篇', beats: ['遇雨'], hook: '有人敲门' })
    expect(outlinePreviewText(cards[1])).toContain('开篇')
    expect(outlinePreviewText(cards[1])).toContain('钩子：有人敲门')
  })

  it('batchChapterTitle 从已有章数续编', () => {
    expect(batchChapterTitle(1, 0)).toBe('第2章')
    expect(batchChapterTitle(0, 9)).toBe('第10章')
  })
})

describe('S4 批量建 10 章顺序', () => {
  it('按细纲行生成 10 个空章并保留顺序与细纲', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '批量建章', projectType: 'webnovel' })
    const docs = new DocumentService(db)
    const volume = docs.listTree(project.id).find((node) => node.type === 'volume')!
    // 默认已有「第一章」；再批量 10 行 → 第2–11章
    const lines = Array.from({ length: 10 }, (_, index) => `细纲要点${index + 1}`)
    const created = docs.batchCreateChaptersFromOutlines({ projectId: project.id, volumeId: volume.id, lines })
    expect(created).toHaveLength(10)
    expect(created.map((node) => node.title)).toEqual(Array.from({ length: 10 }, (_, index) => `第${index + 2}章`))
    expect(created.every((node) => node.wordCount === 0)).toBe(true)
    const chapters = docs.listOrderedChapters(project.id)
    expect(chapters.map((node) => node.title)).toEqual(['第一章', ...created.map((node) => node.title)])
    for (let index = 0; index < 10; index += 1) {
      expect(docs.getOutline(project.id, created[index].id)?.summary).toBe(`细纲要点${index + 1}`)
    }
    // order_index 递增
    const underVolume = docs.listTree(project.id).filter((node) => node.parentId === volume.id && node.type === 'chapter')
      .sort((a, b) => a.orderIndex - b.orderIndex)
    expect(underVolume.map((node) => node.orderIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('拒绝空行集与非卷父节点', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '拒', projectType: 'novel' })
    const docs = new DocumentService(db)
    const volume = docs.listTree(project.id).find((node) => node.type === 'volume')!
    const chapter = docs.listOrderedChapters(project.id)[0]
    expect(() => docs.batchCreateChaptersFromOutlines({ projectId: project.id, volumeId: volume.id, lines: ['  ', ''] }))
      .toThrow('BATCH_OUTLINE_LINES_REQUIRED')
    expect(() => docs.batchCreateChaptersFromOutlines({ projectId: project.id, volumeId: chapter.id, lines: ['x'] }))
      .toThrow('CHAPTER_REQUIRES_VOLUME')
  })
})
