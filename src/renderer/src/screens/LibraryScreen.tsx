import { Archive, Download, FileText, MoreHorizontal, Plus, Search, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Project } from '../../../shared/domain'

const typeName = { novel: '小说', webnovel: '网文', screenplay: '剧本', other: '其他' } as const
const formatCount = (count: number): string => count.toLocaleString('zh-CN')
const relative = (time: number): string => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(time)

export function LibraryScreen({ projects, onOpen, onCreate, onImport, onImportManuscript, onArchive, onBackup, onExport }: {
  projects: Project[]; onOpen(project: Project): void; onCreate(): void; onImport(): void; onImportManuscript(): void; onArchive(project: Project): void; onBackup(project: Project): void
  onExport(project: Project, format: 'txt' | 'md' | 'docx'): void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'recent' | 'archived'>('all')
  const [menuId, setMenuId] = useState<string>()
  const filtered = useMemo(() => projects.filter((project) => {
    if (filter === 'archived' && !project.archived) return false
    if (filter !== 'archived' && project.archived) return false
    return project.title.toLowerCase().includes(query.toLowerCase())
  }), [projects, query, filter])
  const recent = projects.filter((project) => !project.archived).slice(0, 3)

  return <main className="library-screen">
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
              {menuId === project.id && <div className="context-menu"><button onClick={() => onBackup(project)}><Download size={15} />创建项目备份</button><button onClick={() => onExport(project, 'txt')}><FileText size={15} />导出 TXT</button><button onClick={() => onExport(project, 'md')}><FileText size={15} />导出 Markdown</button><button onClick={() => onExport(project, 'docx')}><FileText size={15} />导出 DOCX</button><button onClick={() => onArchive(project)}><Archive size={15} />{project.archived ? '取消归档' : '归档作品'}</button></div>}
            </div>
          </div>)}
        </div>
      </section>
    </>}
    <footer className="library-foot"><ShieldCheck size={15} />所有作品分别保存在本地；正文、记忆、对话与检索索引按作品隔离。</footer>
  </main>
}
