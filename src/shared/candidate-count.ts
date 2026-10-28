/** S8：执笔候选数默认 1、最多 3（PRD §4 / 已决策 12）。 */
export const DEFAULT_CANDIDATE_COUNT = 1
export const MAX_CANDIDATE_COUNT = 3

export function normalizeCandidateCount(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : DEFAULT_CANDIDATE_COUNT
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CANDIDATE_COUNT
  return Math.min(MAX_CANDIDATE_COUNT, n)
}
