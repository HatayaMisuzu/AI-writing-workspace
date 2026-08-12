import { diffLines, diffWordsWithSpace } from 'diff'
import type { DiffSegment } from '../../../shared/domain'

const INLINE_DIFF_LIMIT = 50_000

export function buildHistoryDiff(snapshotText: string, currentText: string): DiffSegment[] {
  const changes = Math.max(snapshotText.length, currentText.length) <= INLINE_DIFF_LIMIT
    ? diffWordsWithSpace(snapshotText, currentText)
    : diffLines(snapshotText, currentText)
  return changes.map((change) => ({
    value: change.value,
    type: change.added ? 'insert' : change.removed ? 'delete' : 'equal'
  }))
}
