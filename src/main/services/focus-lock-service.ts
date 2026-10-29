/**
 * F15 小黑屋：作品级锁定。状态只放在 projects.settings_json（focusLock / focusLastSession），不迁移（D6）。
 * - 进度只读 writing_daily（已保存值；skip / AI 来源的保存本就不计入），与每日目标互不影响。
 * - 时间按墙钟（D4）：elapsed = now() − startedAt，休眠、重启都继续走。
 * - 数据损坏：视为未锁定并记日志，绝不阻止作者打开书稿。
 */
import type { AppDatabase } from '../database/database'
import type { FocusLastSession, FocusLock, FocusLockInput, FocusLockStatus, FocusLockedProject } from '../../shared/domain'
import { localDateKey } from './writing-daily-service'

export const FOCUS_MAX_WORDS = 50_000
export const FOCUS_MAX_MINUTES = 600
export const FOCUS_EXIT_PHRASE = '我要出屋'

export class FocusLockError extends Error {
  constructor(readonly code: 'FOCUS_LOCKED' | 'FOCUS_INVALID' | 'FOCUS_ALREADY_LOCKED' | 'FOCUS_NOT_LOCKED' | 'FOCUS_NOT_REACHED' | 'FOCUS_PHRASE_MISMATCH', message: string) {
    super(message)
    this.name = 'FocusLockError'
  }
  /** Electron invoke 用 `${error}` 拼接报错；只给出文案，不把「FocusLockError:」带给作者。 */
  override toString(): string { return this.message }
}

/** 锁定文案：带上被锁作品的书名（F15 锁定可见性）。全部拒绝是有意设计：任一作品锁定 → 所有作品的 AI 与出站请求都拒绝。 */
export function focusLockedMessage(titles: readonly string[], scope: 'ai' | 'network' = 'ai'): string {
  const named = titles.length ? titles.map((title) => `《${title}》`).join('、') : '某部作品'
  const what = scope === 'ai' ? ' AI 功能' : '联网请求'
  return `${named}正在小黑屋中：锁定期间所有作品的${what}都已关闭，回到${named}出屋后可用。`
}

type SettingsBag = Record<string, unknown>
const isPosInt = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max

/** 校验条件；超限直接拒绝，不自动修正。 */
export function validateFocusInput(input: unknown): FocusLockInput {
  const body = (input ?? {}) as Record<string, unknown>
  const mode = body.mode
  if (mode !== 'words' && mode !== 'minutes' && mode !== 'combo') throw new FocusLockError('FOCUS_INVALID', '请选择锁定方式：字数、时间或组合。')
  const needWords = mode !== 'minutes'
  const needMinutes = mode !== 'words'
  if (needWords && !isPosInt(body.words, FOCUS_MAX_WORDS)) throw new FocusLockError('FOCUS_INVALID', `字数需为 1–${FOCUS_MAX_WORDS} 的整数。`)
  if (needMinutes && !isPosInt(body.minutes, FOCUS_MAX_MINUTES)) throw new FocusLockError('FOCUS_INVALID', `时间需为 1–${FOCUS_MAX_MINUTES} 分钟的整数。`)
  if (!needWords && body.words !== undefined) throw new FocusLockError('FOCUS_INVALID', '时间模式不填写字数。')
  if (!needMinutes && body.minutes !== undefined) throw new FocusLockError('FOCUS_INVALID', '字数模式不填写时间。')
  if (mode === 'combo' && body.combine !== 'all' && body.combine !== 'any') throw new FocusLockError('FOCUS_INVALID', '组合模式需选择「都满足」或「任一满足」。')
  if (mode !== 'combo' && body.combine !== undefined) throw new FocusLockError('FOCUS_INVALID', '只有组合模式需要选择满足方式。')
  return {
    mode,
    ...(needWords ? { words: body.words as number } : {}),
    ...(needMinutes ? { minutes: body.minutes as number } : {}),
    ...(mode === 'combo' ? { combine: body.combine as 'all' | 'any' } : {})
  }
}

const parseLock = (raw: unknown): FocusLock | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const lock = raw as Record<string, unknown>
  try {
    const conditions = validateFocusInput({ mode: lock.mode, words: lock.words, minutes: lock.minutes, combine: lock.combine })
    const nonNeg = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
    if (!nonNeg(lock.startedAt) || !nonNeg(lock.baseAdded) || !nonNeg(lock.baseDeleted)) return undefined
    if (typeof lock.sessionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lock.sessionDate)) return undefined
    return { ...conditions, startedAt: lock.startedAt, baseAdded: lock.baseAdded, baseDeleted: lock.baseDeleted, sessionDate: lock.sessionDate }
  } catch { return undefined }
}

export class FocusLockService {
  constructor(private readonly db: AppDatabase, private readonly now: () => number = () => Date.now()) {}

  private readSettings(projectId: string): SettingsBag {
    const row = this.db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(projectId) as { settings_json: string } | undefined
    if (!row) throw new Error('PROJECT_NOT_FOUND')
    try {
      const parsed = JSON.parse(row.settings_json || '{}') as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SettingsBag : {}
    } catch {
      console.warn(`[focus-lock] settings_json 无法解析，视为未锁定：${projectId}`)
      return {}
    }
  }

  private writeSettings(projectId: string, settings: SettingsBag): void {
    this.db.raw.prepare('UPDATE projects SET settings_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(settings), this.now(), projectId)
  }

  private sums(projectId: string, fromDate: string): { added: number; deleted: number } {
    const row = this.db.raw.prepare(`SELECT COALESCE(SUM(human_words_added), 0) AS added, COALESCE(SUM(human_words_deleted), 0) AS deleted
      FROM writing_daily WHERE project_id = ? AND date >= ?`).get(projectId, fromDate) as { added: number; deleted: number }
    return { added: row.added, deleted: row.deleted }
  }

  /** 读取锁；损坏则记日志并返回 undefined（不改写数据，不阻止打开书稿）。 */
  private readLock(projectId: string): FocusLock | undefined {
    const settings = this.readSettings(projectId)
    if (settings.focusLock === undefined) return undefined
    const lock = parseLock(settings.focusLock)
    if (!lock) console.warn(`[focus-lock] focusLock 数据损坏，视为未锁定：${projectId}`)
    return lock
  }

  start(projectId: string, input: unknown): FocusLockStatus {
    const conditions = validateFocusInput(input)
    if (this.readLock(projectId)) throw new FocusLockError('FOCUS_ALREADY_LOCKED', '本作品已在小黑屋中。')
    const startedAt = this.now()
    const sessionDate = localDateKey(new Date(startedAt))
    const base = this.sums(projectId, sessionDate)
    const settings = this.readSettings(projectId)
    const lock: FocusLock = { ...conditions, startedAt, baseAdded: base.added, baseDeleted: base.deleted, sessionDate }
    settings.focusLock = lock
    this.writeSettings(projectId, settings)
    return this.status(projectId)
  }

  status(projectId: string): FocusLockStatus {
    const lock = this.readLock(projectId)
    if (!lock) return { locked: false, progressWords: 0, elapsedMs: 0, reached: false }
    const sums = this.sums(projectId, lock.sessionDate)
    const progressWords = Math.max(0, (sums.added - lock.baseAdded) - (sums.deleted - lock.baseDeleted))
    const elapsedMs = Math.max(0, this.now() - lock.startedAt)
    const wordsOk = lock.words !== undefined ? progressWords >= lock.words : undefined
    const timeOk = lock.minutes !== undefined ? elapsedMs >= lock.minutes * 60_000 : undefined
    const reached = lock.mode === 'words' ? wordsOk === true
      : lock.mode === 'minutes' ? timeOk === true
      : lock.combine === 'all' ? wordsOk === true && timeOk === true : wordsOk === true || timeOk === true
    const remainingMs = lock.minutes !== undefined ? Math.max(0, lock.minutes * 60_000 - elapsedMs) : undefined
    return { locked: true, lock, progressWords, elapsedMs, ...(remainingMs !== undefined ? { remainingMs } : {}), reached }
  }

  /** 打开作品时调用：仍未达成 → 回到锁定；重启前已达成 → 直接视为结束（记录「达成」）。 */
  restore(projectId: string): FocusLockStatus {
    const current = this.status(projectId)
    if (current.locked && current.reached) { this.end(projectId, current, 'reached'); return this.status(projectId) }
    return current
  }

  isLocked(projectId: string): boolean {
    try { return this.status(projectId).locked } catch { return false }
  }

  /** 当前处于小黑屋中的作品（书名用于提示与报错）。 */
  lockedProjects(): FocusLockedProject[] {
    const rows = this.db.raw.prepare(`SELECT id, title FROM projects WHERE settings_json LIKE '%"focusLock"%' ORDER BY updated_at DESC`).all() as Array<{ id: string; title: string }>
    return rows.filter((row) => this.isLocked(row.id)).map((row) => ({ projectId: row.id, title: row.title }))
  }

  anyLocked(): boolean {
    return this.lockedProjects().length > 0
  }

  /** 正常出屋：仅在达成后可用。 */
  finish(projectId: string): FocusLockStatus {
    const current = this.status(projectId)
    if (!current.locked) throw new FocusLockError('FOCUS_NOT_LOCKED', '当前未在小黑屋中。')
    if (!current.reached) throw new FocusLockError('FOCUS_NOT_REACHED', '尚未达成条件。')
    this.end(projectId, current, 'reached')
    return this.status(projectId)
  }

  /** 紧急出口：输入「我要出屋」确认，无冷却。正文保存由界面先 flush。 */
  emergencyExit(projectId: string, phrase: unknown): FocusLockStatus {
    if (typeof phrase !== 'string' || phrase.trim() !== FOCUS_EXIT_PHRASE) throw new FocusLockError('FOCUS_PHRASE_MISMATCH', `请输入「${FOCUS_EXIT_PHRASE}」确认。`)
    const current = this.status(projectId)
    if (!current.locked) throw new FocusLockError('FOCUS_NOT_LOCKED', '当前未在小黑屋中。')
    this.end(projectId, current, 'emergency')
    return this.status(projectId)
  }

  lastSession(projectId: string): FocusLastSession | undefined {
    const value = this.readSettings(projectId).focusLastSession
    return value && typeof value === 'object' ? value as FocusLastSession : undefined
  }

  private end(projectId: string, current: FocusLockStatus, endedBy: FocusLastSession['endedBy']): void {
    const lock = current.lock!
    const settings = this.readSettings(projectId)
    const record: FocusLastSession = {
      startedAt: lock.startedAt, endedAt: this.now(), mode: lock.mode,
      ...(lock.words !== undefined ? { words: lock.words } : {}),
      ...(lock.minutes !== undefined ? { minutes: lock.minutes } : {}),
      ...(lock.combine ? { combine: lock.combine } : {}),
      netWords: current.progressWords, endedBy
    }
    delete settings.focusLock
    settings.focusLastSession = record
    this.writeSettings(projectId, settings)
  }
}

/**
 * 主进程 AI / 测试连接入口守门：任一作品锁定 → 直接拒绝（code FOCUS_LOCKED），不触达 Provider。
 * 有意不按作品区分：锁定期间整个应用零出站（见 03-f15-spec.md「锁定期间拒绝的出站请求」）。
 */
export function assertNoFocusLockAnywhere(focus: Pick<FocusLockService, 'lockedProjects'>): void {
  const locked = focus.lockedProjects()
  if (locked.length) throw new FocusLockError('FOCUS_LOCKED', focusLockedMessage(locked.map((item) => item.title)))
}
/** 按作品调用的入口：判定同样是「任一作品锁定」（含本作品）；本作品被锁时书名排在前面。 */
export function assertNotFocusLocked(focus: Pick<FocusLockService, 'lockedProjects'>, projectId: string): void {
  const locked = focus.lockedProjects()
  if (!locked.length) return
  const ordered = [...locked.filter((item) => item.projectId === projectId), ...locked.filter((item) => item.projectId !== projectId)]
  throw new FocusLockError('FOCUS_LOCKED', focusLockedMessage(ordered.map((item) => item.title)))
}
