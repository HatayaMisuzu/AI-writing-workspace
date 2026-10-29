/**
 * F14 人物悬停偏好：存放在 projects.settings_json（不迁移，Q2）。
 * - characterHover：总开关，默认开启（未写入 = true）。
 * - hoverIgnoredTerms：「此别名不提示」（characterId + term），只影响悬停。
 * - hoverEnabledSingleTerms：作者手动打开的单字名/别名，影响悬停与「本章提及」（Q1）。
 * 数据损坏 → 视为默认值（空集 / 开启），不阻止打开作品。
 */
import type { AppDatabase } from '../database/database'
import type { CharacterHoverPrefs } from '../../shared/domain'
import { parseHoverTermRefs } from '../../shared/name-matcher'

const readSettings = (db: AppDatabase, projectId: string): Record<string, unknown> => {
  const row = db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(projectId) as { settings_json: string } | undefined
  if (!row) throw new Error('PROJECT_NOT_FOUND')
  try {
    const parsed = JSON.parse(row.settings_json || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { console.warn(`[hover-prefs] settings_json 无法解析，按默认值处理：${projectId}`); return {} }
}

export function readHoverPrefs(db: AppDatabase, projectId: string): CharacterHoverPrefs {
  const settings = readSettings(db, projectId)
  return {
    enabled: settings.characterHover !== false,
    ignoredTerms: parseHoverTermRefs(settings.hoverIgnoredTerms),
    enabledSingleTerms: parseHoverTermRefs(settings.hoverEnabledSingleTerms)
  }
}

/** 只改 settings_json，不动 projects.updated_at（偏好不算写作活动，不改变作品库排序）。 */
export function writeHoverPrefs(db: AppDatabase, projectId: string, prefs: CharacterHoverPrefs): CharacterHoverPrefs {
  const settings = readSettings(db, projectId)
  settings.characterHover = prefs.enabled
  settings.hoverIgnoredTerms = prefs.ignoredTerms.map(({ characterId, term }) => ({ characterId, term }))
  settings.hoverEnabledSingleTerms = prefs.enabledSingleTerms.map(({ characterId, term }) => ({ characterId, term }))
  db.raw.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), projectId)
  return readHoverPrefs(db, projectId)
}
