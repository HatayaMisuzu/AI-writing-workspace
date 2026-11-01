import { useCallback, useEffect, useState } from 'react'
import type { BookCheckResult, DocumentNode, LintGroup, LintRules, Project } from '../../../shared/domain'
import type { WordlistImportPreview } from '../../../shared/wordlist'
import { userErrorMessage } from '../../../shared/user-error'

const CANDIDATE_CHARS = ['的', '了', '是', '在']
const GROUP_LABEL: Record<LintGroup, string> = { punctuation: '标点', wordlist_replace: '词表替换', wordlist_hint: '词表提示', repeat_char: '重复字', halfwidth: '全半角' }
type Scope = 'global' | 'project'

/**
 * F13 校对与词表（作品设置）：作品级 / 全局词表、按类开关、重复字、检查本卷/全书。
 * 纯本地：不联网、不调 AI。小黑屋中整个页面不可见（侧栏隐藏，且这里再判一次）。
 */
export function ProofingView({ project, tree, locked, onOpenChapter }: { project: Project; tree: DocumentNode[]; locked: boolean; onOpenChapter(id: string): void }): React.JSX.Element | null {
  const [projectText, setProjectText] = useState('')
  const [globalText, setGlobalText] = useState('')
  const [rules, setRules] = useState<LintRules>()
  const [whitelistText, setWhitelistText] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>()
  const [preview, setPreview] = useState<WordlistImportPreview & { scope: Scope }>()
  const [volumeId, setVolumeId] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number }>()
  const [runId, setRunId] = useState<string>()
  const [book, setBook] = useState<BookCheckResult>()
  const load = useCallback(async () => {
    const [lists, nextRules] = await Promise.all([window.workspace.wordlist.get(project.id), window.workspace.lint.rules(project.id)])
    setProjectText(lists.projectText); setGlobalText(lists.globalText); setRules(nextRules); setWhitelistText(nextRules.reduplicationWhitelist.join('\n'))
  }, [project.id])
  useEffect(() => { void load() }, [load])
  const guard = async (task: () => Promise<unknown>, ok: string): Promise<void> => {
    try { await task(); setNotice({ ok: true, text: ok }) } catch (error) { setNotice({ ok: false, text: userErrorMessage(error) }) }
  }
  const saveRules = (next: LintRules): Promise<void> => guard(async () => setRules(await window.workspace.lint.setRules(project.id, next)), '规则已保存')
  const startImport = (scope: Scope): Promise<void> => guard(async () => {
    const next = await window.workspace.wordlist.previewImport(scope, scope === 'project' ? project.id : undefined)
    if (next) setPreview({ ...next, scope })
  }, '已读取文件，尚未写入；请核对后确认')
  const runBook = async (): Promise<void> => {
    const id = crypto.randomUUID(); setRunId(id); setBook(undefined); setProgress({ done: 0, total: 0 })
    try { setBook(await window.workspace.lint.checkBook(project.id, volumeId || undefined, id, (done, total) => setProgress({ done, total }))) }
    catch (error) { setNotice({ ok: false, text: userErrorMessage(error) }) }
    finally { setRunId(undefined) }
  }
  const volumes = tree.filter((node) => node.type === 'volume')
  const checkSection = <section data-testid="book-check-section"><h3>检查本卷 / 全书</h3>
    <div className="proofread-actions">
      <select aria-label="检查范围" value={volumeId} onChange={(event) => setVolumeId(event.target.value)}><option value="">全书</option>{volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title}</option>)}</select>
      <button className="primary" disabled={Boolean(runId)} onClick={() => void runBook()}>开始检查</button>
      {runId && <button onClick={() => void window.workspace.lint.cancelBookCheck(runId)}>取消</button>}
      {progress && runId && <span role="status">已检查 {progress.done} / {progress.total} 章</span>}
    </div>
    {book && <div data-testid="book-check-result"><p>{book.cancelled ? '已取消。' : book.timedOut ? '超过 180 秒上限，已停止。' : '检查完成。'}共 {book.total} 条，耗时 {(book.elapsedMs / 1000).toFixed(1)} 秒。结果只做定位，请打开章节后处理。</p>
      <ul>{book.chapters.map((chapter) => <li key={chapter.documentId}><button onClick={() => onOpenChapter(chapter.documentId)}>{chapter.title}</button> {chapter.count} 条（{Object.entries(chapter.groups).map(([group, count]) => `${GROUP_LABEL[group as LintGroup]} ${count}`).join('、')}）{chapter.longChapter ? ' · 章节过长，只查了标点' : ''}</li>)}</ul></div>}
  </section>
  // P3 小黑屋：锁定时只保留整本检查（全书 / 本卷），纯本地、不出站；词表编辑与规则开关等出屋后再改。AI 校对在锁定时本就不显示。
  if (locked) return <section className="prompt-templates-view proofing-view" data-testid="proofing-view">
    <header><h2>整本检查</h2><p>小黑屋中只保留本地检查：不联网、不调用 AI。结果只做定位，点章节名回到正文处理。</p></header>
    {notice && <div className={notice.ok ? 'inline-notice' : 'inline-error'} role={notice.ok ? 'status' : 'alert'}>{notice.text}</div>}
    {checkSection}
  </section>
  return <section className="prompt-templates-view proofing-view" data-testid="proofing-view">
    <header><h2>校对与词表</h2><p>纯本地检查，不联网、不调用 AI。词表结果只在校对抽屉里计数，不在正文加下划线。</p></header>
    {notice && <div className={notice.ok ? 'inline-notice' : 'inline-error'} role={notice.ok ? 'status' : 'alert'}>{notice.text}</div>}
    <section><h3>本作品词表</h3>
      <p className="empty-copy">每行一条：<code>错词=&gt;正词</code> 替换；只写 <code>词</code> 是提示；<code>!词</code> 在本作品关掉同名全局规则；<code>#</code> 开头为注释。</p>
      <textarea aria-label="本作品词表" rows={8} value={projectText} onChange={(event) => setProjectText(event.target.value)} />
      <div className="proofread-actions">
        <button className="primary" onClick={() => void guard(async () => setProjectText((await window.workspace.wordlist.saveProject(project.id, projectText)).projectText), '本作品词表已保存')}>保存本作品词表</button>
        <button onClick={() => void guard(() => window.workspace.wordlist.exportFile('project', project.id), '已导出本作品词表')}>导出本作品词表</button>
        <button onClick={() => void startImport('project')}>导入到本作品词表</button>
      </div>
    </section>
    <section><h3>全局词表（所有作品，不随作品备份）</h3>
      <textarea aria-label="全局词表" rows={8} value={globalText} onChange={(event) => setGlobalText(event.target.value)} />
      <div className="proofread-actions">
        <button className="primary" onClick={() => void guard(async () => setGlobalText((await window.workspace.wordlist.saveGlobal(globalText)).text), '全局词表已保存')}>保存全局词表</button>
        <button onClick={() => void guard(() => window.workspace.wordlist.exportFile('global'), '已导出全局词表')}>导出全局词表</button>
        <button onClick={() => void startImport('global')}>导入到全局词表</button>
      </div>
    </section>
    {preview && <div className="prompt-copy-preview" data-testid="wordlist-import-preview">
      <p>导入到{preview.scope === 'global' ? '全局' : '本作品'}词表：新增 <b data-testid="import-added">{preview.added}</b> / 覆盖 <b data-testid="import-overwritten">{preview.overwritten}</b> / 格式错误行 <b data-testid="import-errors">{preview.errors.length}</b>{preview.unchanged ? `（相同 ${preview.unchanged}）` : ''}</p>
      {preview.errors.length > 0 && <ul>{preview.errors.slice(0, 50).map((item) => <li key={item.line}>第 {item.line} 行：{item.reason}</li>)}</ul>}
      <div className="proofread-actions">
        <button className="primary" onClick={() => void guard(async () => { await window.workspace.wordlist.applyImport(preview.token); setPreview(undefined); await load() }, '词表已导入')}>确认导入</button>
        <button onClick={() => void guard(async () => { await window.workspace.wordlist.cancelImport(); setPreview(undefined) }, '已取消导入，未写入')}>取消</button>
      </div>
    </div>}
    {rules && <section><h3>规则开关（本作品）</h3>
      {(['punctuation', 'wordlist', 'halfwidth', 'repeatChar'] as const).map((key) => <label key={key} className="checkbox-row"><input type="checkbox" checked={rules[key]} onChange={(event) => void saveRules({ ...rules, [key]: event.target.checked })} />{{ punctuation: '标点 / 空格 / 引号', wordlist: '词表', halfwidth: '全半角（中文之间的 , ( )）', repeatChar: '重复字（默认关闭）' }[key]}</label>)}
      {rules.repeatChar && <div><p>要检查的字：</p>{CANDIDATE_CHARS.map((char) => <label key={char} className="checkbox-row"><input type="checkbox" checked={rules.repeatChars.includes(char)} onChange={(event) => void saveRules({ ...rules, repeatChars: event.target.checked ? [...rules.repeatChars, char] : rules.repeatChars.filter((item) => item !== char) })} />{char}</label>)}
        <label><span>叠词白名单（每行一个，不报）</span><textarea aria-label="叠词白名单" rows={4} value={whitelistText} onChange={(event) => setWhitelistText(event.target.value)} /></label>
        <button onClick={() => void saveRules({ ...rules, reduplicationWhitelist: whitelistText.split(/\s+/).filter(Boolean) })}>保存白名单</button></div>}
    </section>}
    {checkSection}
  </section>
}
