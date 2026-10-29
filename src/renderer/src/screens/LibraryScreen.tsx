import { Archive, Download, FileText, MoreHorizontal, Plus, Search, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Project } from '../../../shared/domain'
import type { ExportChapterRange } from '../../../shared/export-range'
import { Modal } from '../components/Modal'

type ExportFormat = 'txt' | 'md' | 'docx'

const typeName = { novel: '小说', webnovel: '网文', screenplay: '剧本', other: '其他' } as const
const formatCount = (count: number): string => count.toLocaleString('zh-CN')
const relative = (time: number): string => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(time)

export function LibraryScreen({ projects, onOpen, onCreate, onImport, onImportManuscript, onArchive, onBackup, onExport }: {
  projects: Project[]; onOpen(project: Project): void; onCreate(): void; onImport(): void; onImportManuscript(): void; onArchive(project: Project): void; onBackup(project: Project): void
  onExport(project: Project, format: ExportFormat, onlyFinal?: boolean, range?: ExportChapterRange): void | Promise<unknown>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'recent' | 'archived'>('all')
  const [menuId, setMenuId] = useState<string>()
  const [exportTarget, setExportTarget] = useState<Project>()
  const filtered = useMemo(() => projects.filter((project) => {
    if (filter === 'archived' && !project.archived) return false
    if (filter !== 'archived' && project.archived) return false
    if (filter === 'recent' && Date.now() - project.lastOpenedAt > 30 * 24 * 60 * 60 * 1000) return false
    return project.title.toLowerCase().includes(query.toLowerCase())
  }), [projects, query, filter])
  const recent = projects.filter((project) => !project.archived).slice(0, 3)

  return <main className="library-screen">
    {exportTarget && <ExportRangeDialog project={exportTarget} onClose={() => setExportTarget(undefined)} onExport={onExport} />}
    <div className="library-head">
      <div><h1>作品库</h1><p>每一部作品都有独立的正文、记忆、对话与检索空间。</p></div>
      <div className="head-actions"><button className="primary" onClick={onCreate}><Plus size={17} />新建作品</button><button onClick={onImportManuscript}><FileText size={17} />导入 TXT/MD</button><button onClick={onImport}><Download size={17} />导入备份</button></div>
    </div>
    {projects.length === 0 ? <section className="empty-library">
      <div className="empty-emblem"><FileText size={34} /></div><h2>从第一部作品开始</h2>
      <p>墨记会把每部作品分别保存在本地。没有模型或网络，也能安心写作。</p>
      <button className="primary" onClick={onCreate}><Plus size={17} />新建作品</button>
    </section> : <>
      <section className="recent-shelf"><h2>最近写作</h2><div className="recent-row">{recent.map((project, index) => <button key={project.id} className="recent-work" onClick={() => onOpen(project)}>
        <span className={`cover cover-${index % 3}`}><span>{project.title.slice(0, 4)}</span></span>
        <span className="recent-meta"><strong>{project.title}</strong><small>{typeName[project.projectType]} · {formatCount(project.totalWordCount)} 字</small><small>{relative(project.updatedAt)}</small></span>
      </button>)}</div></section>
      <section className="library-list-section">
        <div className="list-toolbar">
          <nav>{(['all', 'recent', 'archived'] as const).map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item === 'all' ? '全部作品' : item === 'recent' ? '最近' : '已归档'}</button>)}</nav>
          <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索作品" /></label>
        </div>
        <div className="works-table">
          <div className="table-head"><span>作品名称</span><span>类型</span><span>最后编辑</span><span>总字数</span><span>本地状态</span><span /></div>
          {filtered.map((project, index) => <div className="work-row" key={project.id} onDoubleClick={() => onOpen(project)}>
            <div className="work-name"><span className={`mini-cover cover-${index % 3}`}>{project.title.slice(0, 1)}</span><strong>{project.title}</strong></div>
            <span>{typeName[project.projectType]}</span><span>{relative(project.updatedAt)}</span><span>{formatCount(project.totalWordCount)}</span>
            <span className="local-status"><ShieldCheck size={15} />本地保存</span>
            <div className="row-actions"><button className="text-action" onClick={() => onOpen(project)}>继续写作</button><button className="icon-button" onClick={() => setMenuId(menuId === project.id ? undefined : project.id)}><MoreHorizontal size={18} /></button>
              {menuId === project.id && <div className="context-menu"><button onClick={() => onBackup(project)}><Download size={15} />创建项目备份</button><button onClick={() => onExport(project, 'txt')}><FileText size={15} />导出 TXT</button><button onClick={() => onExport(project, 'md')}><FileText size={15} />导出 Markdown</button><button onClick={() => onExport(project, 'docx')}><FileText size={15} />导出 DOCX</button><button onClick={() => onExport(project, 'txt', true)}><FileText size={15} />导出仅定稿 TXT</button><button onClick={() => onExport(project, 'md', true)}><FileText size={15} />导出仅定稿 Markdown</button><button onClick={() => { setMenuId(undefined); setExportTarget(project) }}><FileText size={15} />按章节范围导出…</button><button onClick={() => onArchive(project)}><Archive size={15} />{project.archived ? '取消归档' : '归档作品'}</button></div>}
            </div>
          </div>)}
        </div>
      </section>
    </>}
    <footer className="library-foot"><ShieldCheck size={15} />所有作品分别保存在本地；正文、记忆、对话与检索索引按作品隔离。</footer>
  </main>
}

/** P1-2 F12：第 N–M 章（章树顺序，1 起始）× 仅定稿 × 格式。 */
function ExportRangeDialog({ project, onClose, onExport }: { project: Project; onClose(): void; onExport(project: Project, format: ExportFormat, onlyFinal?: boolean, range?: ExportChapterRange): void | Promise<unknown> }): React.JSX.Element {
  const [format, setFormat] = useState<ExportFormat>('docx')
  const [onlyFinal, setOnlyFinal] = useState(false)
  const [from, setFrom] = useState('1')
  const [to, setTo] = useState('1')
  const [error, setError] = useState<string>()
  const submit = async (): Promise<void> => {
    const range = { from: Number(from), to: Number(to) }
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 1) { setError('请输入正整数章序号'); return }
    if (range.from > range.to) { setError('起始章不能大于结束章'); return }
    setError(undefined)
    try { await onExport(project, format, onlyFinal, range); onClose() } catch (next) { setError(next instanceof Error ? next.message : String(next)) }
  }
  return <Modal title={`导出《${project.title}》`} onClose={onClose}>
    <label>格式<select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="txt">TXT</option><option value="md">Markdown</option><option value="docx">DOCX</option></select></label>
    <label>第<input type="number" min={1} value={from} onChange={(event) => setFrom(event.target.value)} />章 – 第<input type="number" min={1} value={to} onChange={(event) => setTo(event.target.value)} />章</label>
    <label><input type="checkbox" checked={onlyFinal} onChange={(event) => setOnlyFinal(event.target.checked)} />仅定稿</label>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="modal-actions"><button onClick={onClose}>取消</button><button className="primary" onClick={() => void submit()}>导出</button></div>
  </Modal>
}
