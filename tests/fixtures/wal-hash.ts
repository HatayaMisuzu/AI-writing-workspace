import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

/** 逐章哈希：按章名对齐（导入后 id 会变）；正文 = editor_json + plain_text + revision；快照 = 每份 content/plain_text/reason/revision 的哈希排序后再哈希。 */
export function chapterHashes(raw: DatabaseSync, projectId: string): Record<string, { content: string; snapshots: string; snapshotCount: number }> {
  const nodes = raw.prepare("SELECT id, title FROM document_nodes WHERE project_id = ? AND type = 'chapter' ORDER BY title").all(projectId) as Array<{ id: string; title: string }>
  const out: Record<string, { content: string; snapshots: string; snapshotCount: number }> = {}
  for (const node of nodes) {
    const content = raw.prepare('SELECT editor_json, plain_text, revision FROM document_contents WHERE document_id = ?').get(node.id) as { editor_json: string; plain_text: string; revision: number } | undefined
    const snaps = raw.prepare('SELECT content, plain_text, reason, revision FROM snapshots WHERE document_id = ?').all(node.id) as Array<{ content: string; plain_text: string; reason: string; revision: number }>
    const snapHashes = snaps.map((s) => sha(`${s.reason}|${s.revision}|${s.content}|${s.plain_text}`)).sort()
    out[node.title] = { content: content ? sha(`${content.revision}|${content.editor_json}|${content.plain_text}`) : 'missing', snapshots: sha(snapHashes.join(',')), snapshotCount: snaps.length }
  }
  return out
}
