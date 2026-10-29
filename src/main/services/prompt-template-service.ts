import { createHash } from 'node:crypto'
import type { AIMode } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import {
  DEFAULT_PROMPT_TEMPLATES, PROMPT_ROLE_LABELS, PROMPT_TEMPLATE_MODES, readPromptTemplateOverrides, validatePromptTemplate,
  type PromptCopyPreview, type PromptCopySource, type PromptTemplateEntry, type PromptTemplateOverrides, type PromptTemplateScope,
  type ResolvedPromptTemplate, type PromptScopeChoice, type GlobalImportPreview, type GlobalPromptTemplateEntry
} from '../../shared/prompt-templates'

type SettingsBag = Record<string, unknown>

/** P3 全局模板：应用级存于 app_settings（v10 已有该表，无需迁移），只存相对内置默认的覆盖。 */
export const GLOBAL_PROMPT_TEMPLATES_KEY = 'prompt_templates_global'
export const GLOBAL_TEMPLATE_FILE_FORMAT = 'inkstone-prompt-templates-global'
const MAX_GLOBAL_FILE_CHARS = 1_000_000

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
  setScope(projectId: string, scope: PromptTemplateScope, choice?: PromptScopeChoice): PromptTemplateEntry[] {
    const settings = this.readSettings(projectId)
    let current = this.rawOverrides(settings)
    if (scope === 'project' && this.scopeOf(settings) === 'global') {
      const dormant = Object.keys(readPromptTemplateOverrides(settings)).length > 0
      if (dormant && choice !== 'restore' && choice !== 'fromCurrent') throw Object.assign(new Error('本书保留有上次的本书自定义模板，请选择「恢复上次的本书设置」或「从当前生效内容开始」。'), { code: 'PROMPT_SCOPE_CHOICE_REQUIRED' })
      // M1：restore = 原样恢复上次的本书覆盖（无覆盖的角色走内置默认）；fromCurrent / 无旧覆盖 = 以当前全局生效内容替换本书覆盖（切换瞬间不变）。
      if (!(dormant && choice === 'restore')) current = { ...this.readGlobal() }
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
    // 作者显式编辑本书模板 = 选择「本书自定义」：无旧覆盖时以当前全局为起点切换（其他角色生效内容不变）；有旧覆盖时必须先由作者二选一。
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

  /** 全局模板指纹（只用于导入作品时判断源库/本机全局是否一致；不含正文）。 */
  globalFingerprint(): string { const g = this.readGlobal(); return createHash('sha256').update(JSON.stringify(PROMPT_TEMPLATE_MODES.map((mode) => g[mode] ?? null))).digest('hex') }
  isGlobalEmpty(): boolean { return Object.keys(this.readGlobal()).length === 0 }

  /** M2：全局模板单独文件（不进作品备份）。 */
  exportGlobalFile(): string {
    return JSON.stringify({ format: GLOBAL_TEMPLATE_FILE_FORMAT, version: 1, exportedAt: Date.now(), templates: this.readGlobal() }, null, 2)
  }

  parseGlobalFile(text: string): PromptTemplateOverrides {
    const bad = (detail: string): Error => Object.assign(new Error(`不是有效的全局模板文件：${detail}`), { code: 'PROMPT_GLOBAL_FILE_INVALID' })
    if (text.length > MAX_GLOBAL_FILE_CHARS) throw bad('文件过大。')
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw bad('无法解析 JSON。') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('格式不正确。')
    const file = parsed as Record<string, unknown>
    if (file.format !== GLOBAL_TEMPLATE_FILE_FORMAT || file.version !== 1) throw bad('文件类型或版本不受支持。')
    const templates = file.templates
    if (!templates || typeof templates !== 'object' || Array.isArray(templates)) throw bad('缺少模板内容。')
    const result: PromptTemplateOverrides = {}
    for (const [mode, value] of Object.entries(templates as Record<string, unknown>)) {
      if (!(PROMPT_TEMPLATE_MODES as string[]).includes(mode)) throw bad(`未知角色「${mode}」。`)
      if (typeof value !== 'string') throw bad(`角色「${PROMPT_ROLE_LABELS[mode as AIMode]}」的模板不是文本。`)
      const check = validatePromptTemplate(value)
      if (!check.ok) throw bad(`角色「${PROMPT_ROLE_LABELS[mode as AIMode]}」：${check.error}`)
      if (value !== DEFAULT_PROMPT_TEMPLATES[mode as AIMode]) result[mode as AIMode] = value
    }
    return result
  }

  /** 导入预览：与当前全局逐角色对比；不写库。导入 = 用文件内容整体替换全局（文件未列出的角色回到内置默认）。 */
  previewGlobalImport(text: string): GlobalImportPreview {
    const incoming = this.parseGlobalFile(text)
    const current = this.readGlobal()
    const changes = PROMPT_TEMPLATE_MODES.map((mode) => {
      const now = current[mode] ?? DEFAULT_PROMPT_TEMPLATES[mode]; const next = incoming[mode] ?? DEFAULT_PROMPT_TEMPLATES[mode]
      return { mode, role: PROMPT_ROLE_LABELS[mode], current: now, incoming: next, changed: now !== next }
    })
    const token = createHash('sha256').update(JSON.stringify({ kind: 'global-import', current, incoming })).digest('hex')
    return { changes, changedCount: changes.filter((item) => item.changed).length, token }
  }

  applyGlobalImport(text: string, token: string): GlobalPromptTemplateEntry[] {
    const fresh = this.previewGlobalImport(text)
    if (fresh.token !== token) throw Object.assign(new Error('模板在预览后已变化，请重新预览后再确认。'), { code: 'PROMPT_COPY_STALE' })
    this.writeGlobal(this.parseGlobalFile(text))
    return this.listGlobal()
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
    if (!row) throw Object.assign(new Error('作品不存在或已被删除。'), { code: 'PROJECT_NOT_FOUND' })
    try {
      const parsed = JSON.parse(row.settings_json || '{}') as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SettingsBag : {}
    } catch { return {} }
  }
}
