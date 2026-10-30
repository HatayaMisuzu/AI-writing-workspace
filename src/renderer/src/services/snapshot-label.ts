import type { Snapshot } from '../../../shared/domain'

/** 快照来源文案；全书替换复用 reason=manual，靠 metadata.kind 区分（P3 PR-2b，不改 reason 枚举）。 */
export const snapshotReason = (snapshot: Pick<Snapshot, 'reason' | 'metadata'>): string =>
  snapshot.reason === 'manual' && snapshot.metadata?.kind === 'book_replace' ? '全书替换前' : ({
    interval: '定时保存', large_delete: '大段删除前', ai_edit: 'AI 修改前', manual: '手动快照', pre_restore: '恢复前备份'
  }[snapshot.reason])
