import { BookOpen, Library, Plus, Search, Settings } from 'lucide-react'
import type { Project } from '../../../shared/domain'

export function WorksRail({ projects, activeId, onLibrary, onOpen, onCreate, onSettings, onSearch }: {
  projects: Project[]; activeId?: string; onLibrary(): void; onOpen(project: Project): void; onCreate(): void; onSettings(): void; onSearch(): void
}): React.JSX.Element {
  return <aside className="works-rail">
    <button className={!activeId ? 'rail-action active' : 'rail-action'} onClick={onLibrary} title="作品库">
      <Library size={22} /><span>作品库</span>
    </button>
    <div className="work-tile-list">
      {projects.slice(0, 8).map((project, index) => <button
        key={project.id} className={activeId === project.id ? 'work-tile active' : 'work-tile'}
        onClick={() => onOpen(project)} title={project.title} style={{ '--cover-hue': `${(index * 57 + 174) % 360}` } as React.CSSProperties}
      ><BookOpen size={17} /><span>{project.title.slice(0, 2)}</span></button>)}
      <button className="work-tile add" onClick={onCreate} title="新建作品"><Plus size={20} /></button>
    </div>
    <div className="rail-bottom">
      <button className="rail-icon" onClick={onSearch} title="全局搜索"><Search size={19} /></button>
      <button className="rail-icon" onClick={onSettings} title="设置"><Settings size={19} /></button>
    </div>
  </aside>
}
