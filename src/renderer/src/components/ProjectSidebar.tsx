import { ChevronDown, FileText, Lightbulb, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ChapterStatus, DocumentNode, Project } from '../../../shared/domain'
import { diagCount } from '../services/diag-keystroke'
import { CHAPTER_STATUS_LABEL, CHAPTER_STATUSES } from '../../../shared/stockpile'

export type ProjectSection = 'manuscript' | 'outline' | 'ideas' | 'story' | 'characters' | 'references' | 'ai-data' | 'history' | 'daily' | 'stockpile' | 'foreshadow' | 'timeline' | 'prompts' | 'proofing' | 'book-find'
const sections: Array<[ProjectSection, string]> = [['manuscript','正文'],['outline','大纲'],['ideas','灵感'],['story','故事'],['characters','人物'],['references','资料'],['daily','日更'],['stockpile','存稿'],['foreshadow','伏笔'],['timeline','时间线'],['ai-data','AI 数据'],['prompts','提示词'],['proofing','校对词表'],['book-find','全书查找'],['history','历史']]

const nextStatus = (status: ChapterStatus): ChapterStatus => {
  const index = CHAPTER_STATUSES.indexOf(status)
  return CHAPTER_STATUSES[(index + 1) % CHAPTER_STATUSES.length]
}

export function ProjectSidebar({ project, tree, selectedId, section, onSection, onSelect, onNewVolume, onNewChapter, onRename, onDelete, onReorder, onSetStatus }: {
  project: Project; tree: DocumentNode[]; selectedId?: string; section: ProjectSection; onSection(value: ProjectSection): void
  onSelect(node: DocumentNode): void; onNewVolume(): void; onNewChapter(parentId?: string): void
  onRename(node: DocumentNode): void; onDelete(node: DocumentNode): void
  onReorder(documentId: string, parentId: string, orderIndex: number): void
  onSetStatus?(node: DocumentNode, status: ChapterStatus): void
}): React.JSX.Element {
  diagCount('ProjectSidebar-render')
  const volumes = tree.filter((node) => node.type === 'volume')
  return <aside className="project-sidebar">
    <div className="project-name"><strong>{project.title}</strong></div>
    <nav className="project-sections" aria-label="作品内容区">{sections.map(([value, label]) => <button key={value} className={section === value ? 'active' : ''} onClick={() => onSection(value)}>{label}</button>)}</nav>
    {section === 'manuscript' ? <div className="manuscript-tree">
      {volumes.length === 0 && <div className="tree-empty"><FileText size={24} /><p>先建立一卷，再开始写第一章。</p></div>}
      {volumes.map((volume) => {
        const chapters = tree.filter((node) => node.parentId === volume.id)
        return <div className="volume" key={volume.id}>
        <div className="volume-row" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const draggedId = event.dataTransfer.getData('text/inkstone-document'); if (draggedId) onReorder(draggedId, volume.id, chapters.length) }}><ChevronDown size={16} /><strong>{volume.title}</strong><span /><button className="icon-button tree-node-action" onClick={() => onRename(volume)} title="重命名卷" aria-label={`重命名${volume.title}`}><Pencil size={14} /></button><button className="icon-button tree-node-action danger" onClick={() => onDelete(volume)} title="删除卷" aria-label={`删除${volume.title}`}><Trash2 size={14} /></button><button className="icon-button" onClick={() => onNewChapter(volume.id)} title="在本卷新建章节"><Plus size={15} /></button></div>
        {chapters.map((node, index) => { diagCount('sidebar-chapter-row'); return <div key={node.id} draggable className={node.id === selectedId ? 'chapter-row active' : 'chapter-row'}
          onDragStart={(event) => event.dataTransfer.setData('text/inkstone-document', node.id)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const draggedId = event.dataTransfer.getData('text/inkstone-document'); if (draggedId && draggedId !== node.id) onReorder(draggedId, volume.id, index) }}>
          <button className="chapter-open" onClick={() => onSelect(node)} title={node.title}><FileText size={14} /><span className="chapter-title">{node.title}</span><small>{node.wordCount.toLocaleString()}</small></button>
          <button type="button" className={`chapter-status-badge status-${node.status}`}
            title={`状态：${CHAPTER_STATUS_LABEL[node.status]}（点击切换）`}
            aria-label={`${node.title}状态${CHAPTER_STATUS_LABEL[node.status]}`}
            onClick={(event) => { event.stopPropagation(); onSetStatus?.(node, nextStatus(node.status)) }}
          >{CHAPTER_STATUS_LABEL[node.status]}</button>
          <button className="icon-button tree-node-action" onClick={() => onRename(node)} title="重命名章节" aria-label={`重命名${node.title}`}><Pencil size={13} /></button>
          <button className="icon-button tree-node-action danger" onClick={() => onDelete(node)} title="删除章节" aria-label={`删除${node.title}`}><Trash2 size={13} /></button>
        </div> })}
      </div>})}
      <div className="tree-actions"><button onClick={onNewVolume}><Plus size={15} />新建卷</button><button onClick={() => onNewChapter(volumes[0]?.id)}><Plus size={15} />新建章</button></div>
    </div> : <div className="section-hint"><Lightbulb size={22} /><strong>{sections.find(([value]) => value === section)?.[1]}</strong><p>此区域的内容只属于《{project.title}》。</p></div>}
  </aside>
}
