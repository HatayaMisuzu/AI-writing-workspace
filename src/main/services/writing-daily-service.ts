import type { AppDatabase } from '../database/database'

/** 本机时区 YYYY-MM-DD（跨午夜切分用）。 */
export function localDateKey(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export type WritingDailyRow = {
  date: string
  humanWordsAdded: number
  humanWordsDeleted: number
  /** 显示用净值：max(0, added - deleted)；负值显示 0，删除数单独保留。 */
  humanWordsNetDisplay: number
  aiWordsAccepted: number
  activeSeconds: number
}

/**
 * 可选日更目标视图。数据层不预置任何默认目标值：
 * settings_json 缺省为 {}，字段缺席即「空且未启用」。
 * 本类型的 false/null 是读出时的派生视图，不得写回成默认目标数字。
 */
export type WritingGoals = {
  dailyWordGoalEnabled: boolean
  dailyWordGoal: number | null
  dailyChapterGoalEnabled: boolean
  dailyChapterGoal: number | null
}

export type WritingGoalsInput = {
  dailyWordGoalEnabled?: boolean
  dailyWordGoal?: number | null
  dailyChapterGoalEnabled?: boolean
  dailyChapterGoal?: number | null
}

type SettingsBag = Record<string, unknown>

function assertPositiveIntOrEmpty(label: string, value: number | null | undefined): void {
  if (value === null || value === undefined) return
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`WRITING_GOAL_INVALID:${label}`)
  }
}

export class WritingDailyService {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  private ensureProject(projectId: string): void {
    const row = this.db.raw.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
    if (!row) throw new Error('PROJECT_NOT_FOUND')
  }

  private readSettings(projectId: string): SettingsBag {
    const row = this.db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(projectId) as
      | { settings_json: string }
      | undefined
    if (!row) throw new Error('PROJECT_NOT_FOUND')
    try {
      const parsed = JSON.parse(row.settings_json || '{}') as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SettingsBag : {}
    } catch {
      return {}
    }
  }

  private writeSettings(projectId: string, settings: SettingsBag): void {
    this.db.raw.prepare('UPDATE projects SET settings_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(settings), Date.now(), projectId)
  }

  /** 确保当日行存在（计数为 0），不写任何目标。 */
  private ensureRow(projectId: string, date: string): void {
    this.db.raw.prepare(`INSERT INTO writing_daily(project_id, date, human_words_added, human_words_deleted, ai_words_accepted, active_seconds)
      VALUES (?, ?, 0, 0, 0, 0)
      ON CONFLICT(project_id, date) DO NOTHING`).run(projectId, date)
  }

  addHumanWords(projectId: string, delta: { added?: number; deleted?: number }, at?: Date): void {
    this.ensureProject(projectId)
    const added = Math.max(0, Math.trunc(delta.added ?? 0))
    const deleted = Math.max(0, Math.trunc(delta.deleted ?? 0))
    if (added === 0 && deleted === 0) return
    const date = localDateKey(at ?? this.now())
    this.ensureRow(projectId, date)
    this.db.raw.prepare(`UPDATE writing_daily SET
      human_words_added = human_words_added + ?,
      human_words_deleted = human_words_deleted + ?
      WHERE project_id = ? AND date = ?`).run(added, deleted, projectId, date)
  }

  /** words 可为负（撤销回退）；回退后不低于 0。 */
  addAiAcceptedWords(projectId: string, words: number, at?: Date): void {
    this.ensureProject(projectId)
    const delta = Math.trunc(words)
    if (delta === 0) return
    const date = localDateKey(at ?? this.now())
    this.ensureRow(projectId, date)
    if (delta > 0) {
      this.db.raw.prepare(`UPDATE writing_daily SET ai_words_accepted = ai_words_accepted + ?
        WHERE project_id = ? AND date = ?`).run(delta, projectId, date)
      return
    }
    this.db.raw.prepare(`UPDATE writing_daily SET ai_words_accepted = MAX(0, ai_words_accepted + ?)
      WHERE project_id = ? AND date = ?`).run(delta, projectId, date)
  }

  getDay(projectId: string, date?: string): WritingDailyRow {
    this.ensureProject(projectId)
    const key = date ?? localDateKey(this.now())
    const row = this.db.raw.prepare(`SELECT date, human_words_added, human_words_deleted, ai_words_accepted, active_seconds
      FROM writing_daily WHERE project_id = ? AND date = ?`).get(projectId, key) as
      | { date: string; human_words_added: number; human_words_deleted: number; ai_words_accepted: number; active_seconds: number }
      | undefined
    if (!row) {
      return {
        date: key,
        humanWordsAdded: 0,
        humanWordsDeleted: 0,
        humanWordsNetDisplay: 0,
        aiWordsAccepted: 0,
        activeSeconds: 0
      }
    }
    const net = row.human_words_added - row.human_words_deleted
    return {
      date: row.date,
      humanWordsAdded: row.human_words_added,
      humanWordsDeleted: row.human_words_deleted,
      humanWordsNetDisplay: Math.max(0, net),
      aiWordsAccepted: row.ai_words_accepted,
      activeSeconds: row.active_seconds
    }
  }

  listRange(projectId: string, fromDate: string, toDate: string): WritingDailyRow[] {
    this.ensureProject(projectId)
    const rows = this.db.raw.prepare(`SELECT date, human_words_added, human_words_deleted, ai_words_accepted, active_seconds
      FROM writing_daily WHERE project_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`)
      .all(projectId, fromDate, toDate) as Array<{
      date: string; human_words_added: number; human_words_deleted: number; ai_words_accepted: number; active_seconds: number
    }>
    return rows.map((row) => {
      const net = row.human_words_added - row.human_words_deleted
      return {
        date: row.date,
        humanWordsAdded: row.human_words_added,
        humanWordsDeleted: row.human_words_deleted,
        humanWordsNetDisplay: Math.max(0, net),
        aiWordsAccepted: row.ai_words_accepted,
        activeSeconds: row.active_seconds
      }
    })
  }

  /**
   * 读取目标：settings 中缺席的字段视为空且未启用。
   * 绝不向 settings_json 写入默认数字。
   */
  getGoals(projectId: string): WritingGoals {
    const settings = this.readSettings(projectId)
    const word = settings.dailyWordGoal
    const chapter = settings.dailyChapterGoal
    return {
      dailyWordGoalEnabled: settings.dailyWordGoalEnabled === true,
      dailyWordGoal: typeof word === 'number' && Number.isInteger(word) ? word : null,
      dailyChapterGoalEnabled: settings.dailyChapterGoalEnabled === true,
      dailyChapterGoal: typeof chapter === 'number' && Number.isInteger(chapter) ? chapter : null
    }
  }

  /**
   * 写入目标。0 / 负数 / 非正整数拒绝。
   * 关闭时只改 enabled，不预置目标数字；清空用 null。
   */
  setGoals(projectId: string, input: WritingGoalsInput): WritingGoals {
    this.ensureProject(projectId)
    assertPositiveIntOrEmpty('dailyWordGoal', input.dailyWordGoal)
    assertPositiveIntOrEmpty('dailyChapterGoal', input.dailyChapterGoal)

    const settings = this.readSettings(projectId)

    if (input.dailyWordGoalEnabled !== undefined) {
      if (input.dailyWordGoalEnabled) settings.dailyWordGoalEnabled = true
      else delete settings.dailyWordGoalEnabled
    }
    if (input.dailyWordGoal !== undefined) {
      if (input.dailyWordGoal === null) delete settings.dailyWordGoal
      else settings.dailyWordGoal = input.dailyWordGoal
    }
    if (input.dailyChapterGoalEnabled !== undefined) {
      if (input.dailyChapterGoalEnabled) settings.dailyChapterGoalEnabled = true
      else delete settings.dailyChapterGoalEnabled
    }
    if (input.dailyChapterGoal !== undefined) {
      if (input.dailyChapterGoal === null) delete settings.dailyChapterGoal
      else settings.dailyChapterGoal = input.dailyChapterGoal
    }

    // 开启时必须已有正整数目标（本次或已存）
    const next = {
      dailyWordGoalEnabled: settings.dailyWordGoalEnabled === true,
      dailyWordGoal: typeof settings.dailyWordGoal === 'number' && Number.isInteger(settings.dailyWordGoal)
        ? settings.dailyWordGoal as number
        : null,
      dailyChapterGoalEnabled: settings.dailyChapterGoalEnabled === true,
      dailyChapterGoal: typeof settings.dailyChapterGoal === 'number' && Number.isInteger(settings.dailyChapterGoal)
        ? settings.dailyChapterGoal as number
        : null
    }
    if (next.dailyWordGoalEnabled) {
      assertPositiveIntOrEmpty('dailyWordGoal', next.dailyWordGoal)
      if (next.dailyWordGoal === null) throw new Error('WRITING_GOAL_INVALID:dailyWordGoal')
    }
    if (next.dailyChapterGoalEnabled) {
      assertPositiveIntOrEmpty('dailyChapterGoal', next.dailyChapterGoal)
      if (next.dailyChapterGoal === null) throw new Error('WRITING_GOAL_INVALID:dailyChapterGoal')
    }

    this.writeSettings(projectId, settings)
    return this.getGoals(projectId)
  }
}
