/**
 * F13 本地校对服务（不迁移、不占 v11）：
 * - 全局词表：app_settings key `wordlist_global`（与全局提示词模板同表；不进作品备份）。
 * - 作品级：projects.settings_json 的 wordlist（文本，≤1MB）/ lintRules / lintIgnores（≤5000，超出淘汰最旧）。
 * - 读写 settings_json 都是「读整个对象 → 只改自己的键 → 写回」，不动 projects.updated_at。
 * - 不联网、不调 AI；小黑屋中保存后的自动检查直接跳过。
 */
import { createHash, randomUUID } from 'node:crypto'
import { stat, readFile } from 'node:fs/promises'
import type { AppDatabase } from '../database/database'
import type { BookCheckChapter, BookCheckResult, LintGroup, LintIgnore, LintResult, LintRules, LocalLintIssue, WordlistState } from '../../shared/domain'
import { entryCount, planWordlistImport, WORDLIST_LIMITS, type WordlistImportPreview } from '../../shared/wordlist'
import { DocumentService } from './document-service'
import { lintProject, readLintRules } from './local-rules'

export const GLOBAL_WORDLIST_KEY = 'wordlist_global'
export const LINT_IGNORE_LIMIT = 5000
export const BOOK_CHECK_HARD_LIMIT_MS = 180_000
export type WordlistScope = 'global' | 'project'

const codeError = (message: string, code: string): Error => Object.assign(new Error(message), { code })

/** 读词表文件：先取大小（≤1MB）再读，必须是 UTF-8 文本。 */
export async function readWordlistFile(path: string, io: { stat: typeof stat; readFile: (path: string, encoding: 'utf8') => Promise<string> } = { stat, readFile }): Promise<string> {
  const info = await io.stat(path)
  if (!info.isFile()) throw codeError('不是有效的词表文件：不是普通文件。', 'WORDLIST_FILE_INVALID')
  if (info.size > WORDLIST_LIMITS.projectBytes) throw codeError('词表文件超过 1MB。', 'WORDLIST_FILE_INVALID')
  const text = await io.readFile(path, 'utf8')
  if (text.includes('\u0000')) throw codeError('不是有效的词表文件：不是纯文本。', 'WORDLIST_FILE_INVALID')
  return text
}

export class LintService {
  private readonly documents: DocumentService
  constructor(private readonly db: AppDatabase, private readonly isLocked: (projectId: string) => boolean = () => false) {
    this.documents = new DocumentService(db)
  }

  // ---------- settings ----------
  private readSettings(projectId: string): Record<string, unknown> {
    const row = this.db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(projectId) as { settings_json: string } | undefined
    if (!row) throw new Error('PROJECT_NOT_FOUND')
    try {
      const parsed = JSON.parse(row.settings_json || '{}') as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch { return {} }
  }
  private patchSettings(projectId: string, patch: Record<string, unknown>): void {
    const settings = { ...this.readSettings(projectId), ...patch }
    this.db.raw.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), projectId)
  }

  getGlobalText(): string {
    const row = this.db.raw.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(GLOBAL_WORDLIST_KEY) as { value_json: string } | undefined
    if (!row) return ''
    try { const value = JSON.parse(row.value_json) as unknown; return typeof value === 'string' ? value : '' } catch { return '' }
  }
  getProjectText(projectId: string): string {
    const value = this.readSettings(projectId).wordlist
    return typeof value === 'string' ? value : ''
  }
  getWordlists(projectId: string): WordlistState {
    const globalText = this.getGlobalText(); const projectText = this.getProjectText(projectId)
    return { globalText, projectText, globalCount: entryCount(globalText), projectCount: entryCount(projectText) }
  }
  getGlobalWordlist(): { text: string; count: number } { const text = this.getGlobalText(); return { text, count: entryCount(text) } }

  private assertLimits(globalText: string, projectText: string, scope: WordlistScope): void {
    if (Buffer.byteLength(scope === 'global' ? globalText : projectText, 'utf8') > WORDLIST_LIMITS.projectBytes) throw codeError('词表超过 1MB，未保存。', 'WORDLIST_TOO_LARGE')
    const total = entryCount(globalText) + entryCount(projectText)
    if (total > WORDLIST_LIMITS.entries) throw codeError(`全局与作品词表合计 ${total} 条，超过上限 ${WORDLIST_LIMITS.entries} 条，未保存。`, 'WORDLIST_TOO_MANY')
  }
  saveGlobal(text: string): { text: string; count: number } {
    this.assertLimits(text, '', 'global')
    if (!text.trim()) this.db.raw.prepare('DELETE FROM app_settings WHERE key = ?').run(GLOBAL_WORDLIST_KEY)
    else this.db.raw.prepare(`INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(GLOBAL_WORDLIST_KEY, JSON.stringify(text), Date.now())
    return this.getGlobalWordlist()
  }
  saveProject(projectId: string, text: string): WordlistState {
    this.assertLimits(this.getGlobalText(), text, 'project')
    this.patchSettings(projectId, { wordlist: text })
    return this.getWordlists(projectId)
  }
  /** 「忽略这条规则（本作品）」：词表规则 = 作品级追加 `!词`。 */
  disableTerm(projectId: string, term: string): WordlistState {
    const current = this.getProjectText(projectId)
    return this.saveProject(projectId, `${current}${current && !current.endsWith('\n') ? '\n' : ''}!${term}\n`)
  }

  // ---------- 导入 / 导出 ----------
  private currentText(scope: WordlistScope, projectId?: string): string {
    return scope === 'global' ? this.getGlobalText() : this.getProjectText(projectId!)
  }
  private importToken(scope: WordlistScope, projectId: string | undefined, current: string, incoming: string): string {
    return createHash('sha256').update(`${scope}\u0000${projectId ?? ''}\u0000`).update(current).update('\u0000').update(incoming).digest('hex')
  }
  previewImport(scope: WordlistScope, projectId: string | undefined, incoming: string): WordlistImportPreview {
    const current = this.currentText(scope, projectId)
    const plan = planWordlistImport(current, incoming)
    return { token: this.importToken(scope, projectId, current, incoming), added: plan.added, overwritten: plan.overwritten, unchanged: plan.unchanged, errors: plan.errors }
  }
  /** 确认时重新计算：预览后当前词表被改过 → token 不一致 → 拒绝写入。 */
  applyImport(scope: WordlistScope, projectId: string | undefined, incoming: string, token: string): string {
    const current = this.currentText(scope, projectId)
    if (this.importToken(scope, projectId, current, incoming) !== token) throw codeError('词表在预览后已变化，请重新预览后再确认。', 'WORDLIST_IMPORT_STALE')
    const { nextText } = planWordlistImport(current, incoming)
    if (scope === 'global') this.saveGlobal(nextText); else this.saveProject(projectId!, nextText)
    return nextText
  }
  exportText(scope: WordlistScope, projectId?: string): string { return this.currentText(scope, projectId) }

  // ---------- 规则开关 ----------
  getRules(projectId: string): LintRules { return readLintRules(this.readSettings(projectId).lintRules) }
  setRules(projectId: string, rules: LintRules): LintRules { this.patchSettings(projectId, { lintRules: readLintRules(rules) }); return this.getRules(projectId) }

  // ---------- 忽略这一处 ----------
  listIgnores(projectId: string): LintIgnore[] {
    const raw = this.readSettings(projectId).lintIgnores
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is LintIgnore => Boolean(item) && typeof item === 'object' && typeof item.documentId === 'string' && typeof item.ruleKey === 'string'
      && typeof item.originalText === 'string' && Number.isInteger(item.occurrence) && item.occurrence >= 1 && typeof item.createdAt === 'number')
  }
  private writeIgnores(projectId: string, ignores: LintIgnore[]): void {
    this.patchSettings(projectId, { lintIgnores: ignores.toSorted((a, b) => a.createdAt - b.createdAt).slice(-LINT_IGNORE_LIMIT) })
  }
  addIgnore(projectId: string, input: Omit<LintIgnore, 'createdAt'>, now = Date.now()): LintIgnore[] {
    const rest = this.listIgnores(projectId).filter((item) => !(item.documentId === input.documentId && item.ruleKey === input.ruleKey && item.originalText === input.originalText && item.occurrence === input.occurrence))
    this.writeIgnores(projectId, [...rest, { ...input, createdAt: now }])
    return this.listIgnores(projectId)
  }

  /** 按 (ruleKey, originalText) 分组后第 n 条；找不到的忽略视为失效并清除。 */
  private applyIgnores(projectId: string, documentId: string, issues: LocalLintIssue[], persist: boolean): LocalLintIssue[] {
    const ordinal = new Map<string, number>()
    const keyed = issues.map((issue) => {
      const key = `${issue.ruleKey ?? issue.kind}\u0000${issue.originalText}`
      const n = (ordinal.get(key) ?? 0) + 1; ordinal.set(key, n)
      return { issue: { ...issue, occurrence: n }, key: `${key}\u0000${n}` }
    })
    const all = this.listIgnores(projectId)
    const mine = all.filter((item) => item.documentId === documentId)
    if (!mine.length) return keyed.map((item) => item.issue)
    const present = new Set(keyed.map((item) => item.key))
    const ignoreKey = (item: LintIgnore): string => `${item.ruleKey}\u0000${item.originalText}\u0000${item.occurrence}`
    const active = new Set(mine.map(ignoreKey).filter((key) => present.has(key)))
    if (persist && active.size !== mine.length) this.writeIgnores(projectId, all.filter((item) => item.documentId !== documentId || active.has(ignoreKey(item))))
    return keyed.filter((item) => !active.has(item.key)).map((item) => item.issue)
  }

  // ---------- 检查 ----------
  /** IPC linter:run：保存后自动 / 抽屉手动。小黑屋中 → 不运行（组长决定 3）。 */
  run(projectId: string, documentId: string, text: string, sourceRevision = -1): LintResult {
    if (this.isLocked(projectId)) return { issues: [], longChapter: false, skipped: 'focus-locked', elapsedMs: 0 }
    const started = performance.now()
    const result = lintProject({ text, documentId, sourceRevision, globalText: this.getGlobalText(), projectText: this.getProjectText(projectId), rules: this.getRules(projectId) })
    const issues = this.applyIgnores(projectId, documentId, result.issues, true)
    return { issues, longChapter: result.longChapter, elapsedMs: performance.now() - started }
  }

  private readonly bookRuns = new Map<string, { cancelled: boolean }>()
  cancelBookCheck(runId: string): void { const run = this.bookRuns.get(runId); if (run) run.cancelled = true }
  /** 检查本卷 / 全书：逐章执行，章与章之间让出主线程；可取消；硬上限 180 秒；只做定位，不跨章批量应用。 */
  async checkBook(projectId: string, options: { volumeId?: string; runId?: string; onProgress?(done: number, total: number): void; now?: () => number; hardLimitMs?: number } = {}): Promise<BookCheckResult> {
    const runId = options.runId ?? randomUUID()
    const state = { cancelled: false }
    this.bookRuns.set(runId, state)
    const now = options.now ?? (() => performance.now())
    const started = now()
    const limit = options.hardLimitMs ?? BOOK_CHECK_HARD_LIMIT_MS
    try {
      const chapters = this.documents.listOrderedChapters(projectId).filter((node) => !options.volumeId || node.parentId === options.volumeId)
      const globalText = this.getGlobalText(); const projectText = this.getProjectText(projectId); const rules = this.getRules(projectId)
      const results: BookCheckChapter[] = []
      let timedOut = false
      for (const [index, node] of chapters.entries()) {
        if (state.cancelled || this.isLocked(projectId)) { state.cancelled = true; break }
        if (now() - started > limit) { timedOut = true; break }
        const content = this.documents.getContent(projectId, node.id)
        const lint = lintProject({ text: content.plainText, documentId: node.id, sourceRevision: content.revision, globalText, projectText, rules })
        const issues = this.applyIgnores(projectId, node.id, lint.issues, false)
        const groups: Partial<Record<LintGroup, number>> = {}
        for (const issue of issues) if (issue.group) groups[issue.group] = (groups[issue.group] ?? 0) + 1
        if (issues.length || lint.longChapter) results.push({ documentId: node.id, title: node.title, count: issues.length, groups, longChapter: lint.longChapter })
        options.onProgress?.(index + 1, chapters.length)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      return { runId, chapters: results, total: results.reduce((sum, item) => sum + item.count, 0), elapsedMs: now() - started, cancelled: state.cancelled, timedOut }
    } finally { this.bookRuns.delete(runId) }
  }
}
