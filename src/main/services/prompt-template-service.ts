import { createHash } from 'node:crypto'
import type { AIMode } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import {
  DEFAULT_PROMPT_TEMPLATES, PROMPT_ROLE_LABELS, PROMPT_TEMPLATE_MODES, readPromptTemplateOverrides, validatePromptTemplate,
  type PromptCopyPreview, type PromptCopySource, type PromptTemplateEntry, type PromptTemplateOverrides, type PromptTemplateScope,
  type ResolvedPromptTemplate
} from '../../shared/prompt-templates'

type SettingsBag = Record<string, unknown>

/** P3 全局模板：应用级存于 app_settings（v10 已有该表，无需迁移），只存相对内置默认的覆盖。 */
export const GLOBAL_PROMPT_TEMPLATES_KEY = 'prompt_templates_global'

const templateError = (message: string): Error => Object.assign(new Error(message), { code: 'PROMPT_TEMPLATE_INVALID' })

/**
 * P1-4：本书覆盖存于 projects.settings_json.promptTemplates（只存覆盖；恢复默认 = 删除该键）。
 * P3：本书开关存于 settings_json.promptTemplateScope：'global'（沿用全局）| 'project'（本书自定义）。
 *   缺席时按规则推导（不写库、无迁移）：本书有任一合法覆盖 → 'project'；否则 → 'global'。
 *   生效规则：project → 本书覆盖 ?? 内置默认（不受全局影响）；global → 全局覆盖 ?? 内置默认。
 */
export class PromptTemplateService {
  constructor(private readonly db: AppDatabase) {}

  list(projectId: string): PromptTemplateEntry[] {
    const settings = this.readSettings(projectId)
    const overrides = readPromptTemplateOverrides(settings)
    const global = this.readGlobal()
    const scope = this.scopeOf(settings)
    return PROMPT_TEMPLATE_MODES.map((mode) => {
      const resolved = this.resolveWith(scope, overrides, global, mode)
      return { mode, role: PROMPT_ROLE_LABELS[mode], defaultTemplate: DEFAULT_PROMPT_TEMPLATES[mode], override: overrides[mode] ?? null,
        globalOverride: global[mode] ?? null, effective: resolved.text, source: resolved.source, scope }
    })
  }

  getScope(projectId: string): PromptTemplateScope { return this.scopeOf(this.readSettings(projectId)) }

  /**
   * 切换开关。切到「本书自定义」时，本书尚无覆盖的模式以当时全局生效内容播种，切换瞬间实际生效模板不变；
   * 切回「沿用全局」时本书覆盖保留（休眠，不生效），再切回自定义可恢复。
   */
  setScope(projectId: string, scope: PromptTemplateScope): PromptTemplateEntry[] {
    const settings = this.readSettings(projectId)
    const current = this.rawOverrides(settings)
    if (scope === 'project' && this.scopeOf(settings) === 'global') {
      const global = this.readGlobal()
      for (const mode of PROMPT_TEMPLATE_MODES) if (current[mode] === undefined && global[mode] !== undefined) current[mode] = global[mode]
    }
    settings.promptTemplateScope = scope
    this.writeTemplates(projectId, settings, current)
    return this.list(projectId)
  }

  /** 作者覆盖或全局覆盖；内置默认返回 undefined。未知项目同样返回 undefined（不影响 AI 调用）。 */
  getOverride(projectId: string, mode: AIMode): string | undefined {
    const resolved = this.resolve(projectId, mode)
    return resolved.source === 'builtin' ? undefined : resolved.text
  }

  /** 实际生效模板与来源（全局 / 本书 / 内置默认）。 */
  resolve(projectId: string, mode: AIMode): ResolvedPromptTemplate {
    try {
      const settings = this.readSettings(projectId)
      return this.resolveWith(this.scopeOf(settings), readPromptTemplateOverrides(settings), this.readGlobal(), mode)
    } catch { return { mode, source: 'builtin', text: DEFAULT_PROMPT_TEMPLATES[mode] } }
  }

  /** 编辑本书模板。仅在「本书自定义」下允许，避免作者以为在改全局却悄悄改了本书。 */
  set(projectId: string, mode: AIMode, text: string): PromptTemplateEntry[] {
    const check = validatePromptTemplate(text)
    if (!check.ok) throw templateError(check.error)
    // 作者显式编辑本书模板 = 选择「本书自定义」：先以当前全局为起点切换（其他角色生效内容不变），再写入本角色。
    if (this.getScope(projectId) !== 'project') this.setScope(projectId, 'project')
    const settings = this.readSettings(projectId)
    const current = this.rawOverrides(settings)
    if (text === DEFAULT_PROMPT_TEMPLATES[mode]) delete current[mode]
    else current[mode] = text
    settings.promptTemplateScope = 'project'
    this.writeTemplates(projectId, settings, current)
    return this.list(projectId)
  }

  reset(projectId: string, mode: AIMode): PromptTemplateEntry[] {
    const settings = this.readSettings(projectId)
    const scope = this.scopeOf(settings)
    const current = this.rawOverrides(settings)
    delete current[mode]
    settings.promptTemplateScope = scope // 显式固定开关：删光覆盖后不会被推导成「沿用全局」
    this.writeTemplates(projectId, settings, current)
    return this.list(projectId)
  }

  listGlobal(): Array<{ mode: AIMode; role: string; defaultTemplate: string; override: string | null }> {
    const global = this.readGlobal()
    return PROMPT_TEMPLATE_MODES.map((mode) => ({ mode, role: PROMPT_ROLE_LABELS[mode], defaultTemplate: DEFAULT_PROMPT_TEMPLATES[mode], override: global[mode] ?? null }))
  }

  setGlobal(mode: AIMode, text: string): ReturnType<PromptTemplateService['listGlobal']> {
    if (!PROMPT_TEMPLATE_MODES.includes(mode)) throw templateError(`未知角色：${mode}`)
    const check = validatePromptTemplate(text)
    if (!check.ok) throw templateError(check.error)
    const global = this.readGlobal()
    if (text === DEFAULT_PROMPT_TEMPLATES[mode]) delete global[mode]
    else global[mode] = text
    this.writeGlobal(global)
    return this.listGlobal()
  }

  resetGlobal(mode: AIMode): ReturnType<PromptTemplateService['listGlobal']> {
    const global = this.readGlobal()
    delete global[mode]
    this.writeGlobal(global)
    return this.listGlobal()
  }

  /** 复制前预览：逐模式列出本书当前生效内容与复制后内容；不写库。token 绑定双方当前状态，确认时校验未变化。 */
  previewCopy(targetProjectId: string, source: PromptCopySource): PromptCopyPreview {
    if (source.kind === 'project' && source.projectId === targetProjectId) throw Object.assign(new Error('不能从本书复制到本书。'), { code: 'PROMPT_COPY_SAME_PROJECT' })
    const incoming = this.sourceTemplates(source)
    const target = this.list(targetProjectId)
    const changes = target.map((entry) => ({ mode: entry.mode, role: entry.role, current: entry.effective, currentSource: entry.source,
      incoming: incoming[entry.mode] ?? DEFAULT_PROMPT_TEMPLATES[entry.mode], changed: entry.effective !== (incoming[entry.mode] ?? DEFAULT_PROMPT_TEMPLATES[entry.mode]) }))
    const token = createHash('sha256').update(JSON.stringify({ targetProjectId, source, incoming, target: this.readSettings(targetProjectId).promptTemplates ?? null, effective: target.map((entry) => [entry.source, entry.effective]), scope: this.getScope(targetProjectId) })).digest('hex')
    return { targetProjectId, source, changes, changedCount: changes.filter((item) => item.changed).length, token }
  }

  /** 作者确认后写入：本书切到「本书自定义」，覆盖 = 来源生效内容（等于内置默认的不存）。token 不匹配（任一方已改动）则拒绝。 */
  applyCopy(targetProjectId: string, source: PromptCopySource, token: string): PromptTemplateEntry[] {
    const fresh = this.previewCopy(targetProjectId, source)
    if (fresh.token !== token) throw Object.assign(new Error('模板在预览后已变化，请重新预览后再确认。'), { code: 'PROMPT_COPY_STALE' })
    const incoming = this.sourceTemplates(source)
    const settings = this.readSettings(targetProjectId)
    settings.promptTemplateScope = 'project'
    this.writeTemplates(targetProjectId, settings, { ...incoming })
    return this.list(targetProjectId)
  }

  private sourceTemplates(source: PromptCopySource): PromptTemplateOverrides {
    if (source.kind === 'global') return this.readGlobal()
    const settings = this.readSettings(source.projectId)
    const scope = this.scopeOf(settings)
    const overrides = readPromptTemplateOverrides(settings)
    const global = this.readGlobal()
    const result: PromptTemplateOverrides = {}
    for (const mode of PROMPT_TEMPLATE_MODES) {
      const resolved = this.resolveWith(scope, overrides, global, mode)
      if (resolved.source !== 'builtin') result[mode] = resolved.text
    }
    return result
  }

  private resolveWith(scope: PromptTemplateScope, overrides: PromptTemplateOverrides, global: PromptTemplateOverrides, mode: AIMode): ResolvedPromptTemplate {
    if (scope === 'project') return overrides[mode] !== undefined ? { mode, source: 'project', text: overrides[mode]! } : { mode, source: 'builtin', text: DEFAULT_PROMPT_TEMPLATES[mode] }
    return global[mode] !== undefined ? { mode, source: 'global', text: global[mode]! } : { mode, source: 'builtin', text: DEFAULT_PROMPT_TEMPLATES[mode] }
  }

  private scopeOf(settings: SettingsBag): PromptTemplateScope {
    if (settings.promptTemplateScope === 'project' || settings.promptTemplateScope === 'global') return settings.promptTemplateScope
    return Object.keys(readPromptTemplateOverrides(settings)).length ? 'project' : 'global'
  }

  private rawOverrides(settings: SettingsBag): Record<string, unknown> {
    return settings.promptTemplates && typeof settings.promptTemplates === 'object' && !Array.isArray(settings.promptTemplates)
      ? { ...(settings.promptTemplates as Record<string, unknown>) } : {}
  }

  private readGlobal(): PromptTemplateOverrides {
    const row = this.db.raw.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(GLOBAL_PROMPT_TEMPLATES_KEY) as { value_json: string } | undefined
    if (!row) return {}
    try { return readPromptTemplateOverrides({ promptTemplates: JSON.parse(row.value_json) as unknown }) } catch { return {} }
  }

  private writeGlobal(global: PromptTemplateOverrides): void {
    if (!Object.keys(global).length) { this.db.raw.prepare('DELETE FROM app_settings WHERE key = ?').run(GLOBAL_PROMPT_TEMPLATES_KEY); return }
    this.db.raw.prepare(`INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(GLOBAL_PROMPT_TEMPLATES_KEY, JSON.stringify(global), Date.now())
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
