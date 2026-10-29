/**
 * PR37 复验 ①：「应用」一条本地校对建议后，不再整章重跑 + 整个抽屉重建，
 * 而是只把受影响的提示增量更新：
 * - 被应用的那条删除；与改动区间重叠的提示失效删除；
 * - 改动之后的提示 from/to 平移 delta；
 * - 同一 (ruleKey ?? kind, originalText) 在改动之后的第几处（occurrence）减 1（与重跑时主进程的编号一致）；
 * - sourceTextHash 换成改动后正文的哈希（批量应用 / 再次应用的校验仍然有效）。
 * 局限：替换文字与左右邻字新组成 / 拆散的命中不会出现 / 消失，下次手动重新检查或正常输入保存后的重跑会补上。
 */
import type { LocalLintIssue } from '../../../shared/domain'

export interface AppliedLocalEdit {
  issueId: string
  /** 改动前纯文本区间 */
  from: number
  to: number
  replacementLength: number
}

const occurrenceKey = (issue: LocalLintIssue): string => `${issue.ruleKey ?? issue.kind}\u0000${issue.originalText}`

export function shiftIssuesAfterEdit(issues: LocalLintIssue[], edit: AppliedLocalEdit, nextTextHash: string): LocalLintIssue[] {
  const applied = issues.find((issue) => issue.id === edit.issueId)
  const appliedKey = applied ? occurrenceKey(applied) : undefined
  const delta = edit.replacementLength - (edit.to - edit.from)
  const result: LocalLintIssue[] = []
  for (const issue of issues) {
    if (issue.id === edit.issueId) continue
    const overlaps = issue.from < edit.to && issue.to > edit.from
    if (overlaps) continue
    const after = issue.from >= edit.to
    const occurrence = after && appliedKey !== undefined && issue.occurrence && occurrenceKey(issue) === appliedKey ? issue.occurrence - 1 : issue.occurrence
    result.push({ ...issue, from: after ? issue.from + delta : issue.from, to: after ? issue.to + delta : issue.to, occurrence, sourceTextHash: nextTextHash })
  }
  return result
}
