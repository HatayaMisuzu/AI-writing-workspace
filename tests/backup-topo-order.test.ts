import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { BackupService, orderNodesParentFirst } from '../src/main/services/backup-service'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
const tempFile = async (name: string) => { const dir = await mkdtemp(join(tmpdir(), 'inkstone-s1e-')); dirs.push(dir); return join(dir, name) }

/** 三级结构作品；章节被移到后建的卷下，SELECT 默认顺序下子节点可能排在父节点前（不保证顺序）。 */
const seed = () => {
  const db = createTestDb(); const projects = new ProjectService(db); const docs = new DocumentService(db)
  const project = projects.create({ title: '带场景的作品', projectType: 'novel' })
  const volumeA = docs.createNode({ projectId: project.id, type: 'volume', title: '卷一' })
  const chapter = docs.createNode({ projectId: project.id, parentId: volumeA.id, type: 'chapter', title: '第一章' })
  const scene = docs.createNode({ projectId: project.id, parentId: chapter.id, type: 'scene', title: '场景一' })
  docs.saveContent({ projectId: project.id, documentId: scene.id, editorJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '场景正文😀' }] }] }, plainText: '场景正文😀' })
  const volumeB = docs.createNode({ projectId: project.id, type: 'volume', title: '卷二' })
  const late = docs.createNode({ projectId: project.id, parentId: volumeB.id, type: 'chapter', title: '后建章' })
  docs.reorder(project.id, chapter.id, volumeB.id, 0)
  return { db, projects, docs, project, ids: { volumeA, volumeB, chapter, scene, late } }
}

const shape = (docs: DocumentService, projectId: string) => {
  const nodes = docs.listTree(projectId)
  const title = new Map(nodes.map((node) => [node.id, node.title]))
  return nodes.map((node) => `${node.type}:${node.title}<${node.parentId ? title.get(node.parentId) : '-'}#${node.orderIndex}`).sort()
}

describe('S1e 备份按层级拓扑排序', () => {
  it('带场景的作品完整导出→导入往返：导出父节点在前，导入后树与正文一致', async () => {
    const { db, docs, project } = seed()
    const path = await tempFile('roundtrip.inkstone.json'); const backup = new BackupService(db)
    await backup.exportProject(project.id, path)
    const exported = JSON.parse(await readFile(path, 'utf8')) as { nodes: Array<{ id: string; parent_id: string | null }> }
    const seen = new Set<string>()
    for (const node of exported.nodes) { if (node.parent_id) expect(seen.has(node.parent_id)).toBe(true); seen.add(node.id) }
    const imported = await backup.importProject(path)
    expect(shape(docs, imported.id)).toEqual(shape(docs, project.id))
    const scene = docs.listTree(imported.id).find((node) => node.type === 'scene')!
    expect(docs.getContent(imported.id, scene.id).plainText).toBe('场景正文😀')
  })

  it('乱序的旧备份（子在父前）可以导入', async () => {
    const { db, docs, project } = seed()
    const path = await tempFile('legacy.inkstone.json'); const backup = new BackupService(db)
    await backup.exportProject(project.id, path)
    const payload = JSON.parse(await readFile(path, 'utf8')) as { nodes: unknown[] }
    payload.nodes.reverse()
    await writeFile(path, JSON.stringify(payload))
    const imported = await backup.importProject(path)
    expect(shape(docs, imported.id)).toEqual(shape(docs, project.id))
  })

  it.each([
    ['环', (nodes: Array<Record<string, unknown>>) => { const b = nodes.find((n) => n.type === 'scene')!; const a = nodes.find((n) => n.id === b.parent_id)!; a.parent_id = b.id }, 'BACKUP_INVALID_NODE_CYCLE'],
    ['自指', (nodes: Array<Record<string, unknown>>) => { const a = nodes.find((n) => n.type === 'volume')!; a.parent_id = a.id }, 'BACKUP_INVALID_NODE_CYCLE'],
    ['缺失父节点', (nodes: Array<Record<string, unknown>>) => { nodes.find((n) => n.type === 'scene')!.parent_id = 'missing-parent' }, 'BACKUP_INVALID_NODE_PARENT']
  ])('%s：安全报错，现有数据不变', async (_name, mutate, code) => {
    const { db, project } = seed()
    const path = await tempFile('bad.inkstone.json'); const backup = new BackupService(db)
    await backup.exportProject(project.id, path)
    const payload = JSON.parse(await readFile(path, 'utf8')) as { nodes: Array<Record<string, unknown>> }
    mutate(payload.nodes)
    await writeFile(path, JSON.stringify(payload))
    const count = (table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    const before = ['projects', 'document_nodes', 'document_contents'].map(count)
    await expect(backup.importProject(path)).rejects.toThrow(code)
    expect(['projects', 'document_nodes', 'document_contents'].map(count)).toEqual(before)
  })

  it('orderNodesParentFirst：同层按 order_index，跨层父在前', () => {
    const nodes = [
      { id: 's', parent_id: 'c', order_index: 0 }, { id: 'c2', parent_id: 'v', order_index: 1 },
      { id: 'c', parent_id: 'v', order_index: 0 }, { id: 'v', parent_id: null, order_index: 0 }
    ]
    expect(orderNodesParentFirst(nodes).map((node) => node.id)).toEqual(['v', 'c', 'c2', 's'])
  })
})
