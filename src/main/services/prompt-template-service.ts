import type { AIMode } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import {
  DEFAULT_PROMPT_TEMPLATES, PROMPT_ROLE_LABELS, PROMPT_TEMPLATE_MODES, readPromptTemplateOverrides, validatePromptTemplate,
  type PromptTemplateEntry
} from '../../shared/prompt-templates'

type SettingsBag = Record<string, unknown>

/** P1-4：作者覆盖存于 projects.settings_json.promptTemplates，只存覆盖；恢复默认 = 删除该键。无迁移。 */
export class PromptTemplateService {
  constructor(private readonly db: AppDatabase) {}

  list(projectId: string): PromptTemplateEntry[] {
    const overrides = readPromptTemplateOverrides(this.readSettings(projectId))
    return PROMPT_TEMPLATE_MODES.map((mode) => ({ mode, role: PROMPT_ROLE_LABELS[mode], defaultTemplate: DEFAULT_PROMPT_TEMPLATES[mode], override: overrides[mode] ?? null }))
  }

  /** 作者覆盖；无覆盖返回 undefined。未知项目同样返回 undefined（不影响 AI 调用）。 */
  getOverride(projectId: string, mode: AIMode): string | undefined {
    try { return readPromptTemplateOverrides(this.readSettings(projectId))[mode] } catch { return undefined }
  }

  set(projectId: string, mode: AIMode, text: string): PromptTemplateEntry[] {
    const check = validatePromptTemplate(text)
    if (!check.ok) throw Object.assign(new Error(check.error), { code: 'PROMPT_TEMPLATE_INVALID' })
    const settings = this.readSettings(projectId)
    const current = settings.promptTemplates && typeof settings.promptTemplates === 'object' && !Array.isArray(settings.promptTemplates)
      ? { ...(settings.promptTemplates as Record<string, unknown>) } : {}
    if (text === DEFAULT_PROMPT_TEMPLATES[mode]) delete current[mode]
    else current[mode] = text
    this.writeTemplates(projectId, settings, current)
    return this.list(projectId)
  }

  reset(projectId: string, mode: AIMode): PromptTemplateEntry[] {
    const settings = this.readSettings(projectId)
    const current = settings.promptTemplates && typeof settings.promptTemplates === 'object' && !Array.isArray(settings.promptTemplates)
      ? { ...(settings.promptTemplates as Record<string, unknown>) } : {}
    delete current[mode]
    this.writeTemplates(projectId, settings, current)
    return this.list(projectId)
  }

  private writeTemplates(projectId: string, settings: SettingsBag, templates: Record<string, unknown>): void {
    if (Object.keys(templates).length) settings.promptTemplates = templates
    else delete settings.promptTemplates
    this.db.raw.prepare('UPDATE projects SET settings_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(settings), Date.now(), projectId)
  }

  private readSettings(projectId: string): SettingsBag {
    const row = this.db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(projectId) as { settings_json: string } | undefined
    if (!row) throw new Error('PROJECT_NOT_FOUND')
    try {
      const parsed = JSON.parse(row.settings_json || '{}') as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SettingsBag : {}
    } catch { return {} }
  }
}
