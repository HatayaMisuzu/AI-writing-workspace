import { useCallback, useEffect, useState } from 'react'
import type { Project, ProjectType } from '../../shared/domain'
import { TitleBar } from './components/TitleBar'
import { WorksRail } from './components/WorksRail'
import { Modal } from './components/Modal'
import { LibraryScreen } from './screens/LibraryScreen'
import { WorkspaceScreen } from './screens/WorkspaceScreen'
import { SettingsScreen } from './screens/SettingsScreen'

type Screen = { type: 'library' } | { type: 'workspace'; projectId: string } | { type: 'settings' }

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [screen, setScreen] = useState<Screen>({ type: 'library' })
  const [createOpen, setCreateOpen] = useState(false)
  const [newProject, setNewProject] = useState<{ title: string; projectType: ProjectType; description: string }>({ title: '', projectType: 'novel', description: '' })
  const active = screen.type === 'workspace' ? projects.find((project) => project.id === screen.projectId) : undefined
  const reload = useCallback(async () => setProjects(await window.workspace.projects.list(true)), [])
  useEffect(() => { void reload() }, [reload])

  const open = (project: Project): void => setScreen({ type: 'workspace', projectId: project.id })
  const create = async (): Promise<void> => {
    if (!newProject.title.trim()) return
    const project = await window.workspace.projects.create(newProject)
    setCreateOpen(false); setNewProject({ title: '', projectType: 'novel', description: '' }); await reload(); open(project)
  }
  const title = screen.type === 'library' ? '作品库' : screen.type === 'settings' ? '设置 · 模型与服务' : active ? `${active.title} · 写作` : '墨记'

  return <div className="app-shell">
    <TitleBar title={title} />
    <div className="app-body">
      <WorksRail projects={projects.filter((project) => !project.archived)} activeId={active?.id} onLibrary={() => setScreen({ type: 'library' })} onOpen={open} onCreate={() => setCreateOpen(true)} onSettings={() => setScreen({ type: 'settings' })} onSearch={() => setScreen({ type: 'library' })} />
      <div className="screen-host">
        {screen.type === 'library' ? <LibraryScreen projects={projects} onOpen={open} onCreate={() => setCreateOpen(true)} onImport={async () => { const project = await window.workspace.backup.importProject(); if (project) { await reload(); open(project) } }} onImportManuscript={async () => { const project = await window.workspace.backup.importManuscript(); if (project) { await reload(); open(project) } }} onArchive={async (project) => { await window.workspace.projects.archive(project.id, !project.archived); await reload() }} onBackup={(project) => void window.workspace.backup.exportProject(project.id)} onExport={(project, format) => void window.workspace.backup.exportManuscript(project.id, format)} />
          : screen.type === 'settings' ? <SettingsScreen />
          : active ? <WorkspaceScreen project={active} onProjectChanged={() => void reload()} onSettings={() => setScreen({ type: 'settings' })} />
          : <div className="fatal-view">作品不存在或已被删除。<button onClick={() => setScreen({ type: 'library' })}>返回作品库</button></div>}
      </div>
    </div>
    {createOpen && <Modal title="新建作品" onClose={() => setCreateOpen(false)}><form className="project-form" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <label><span>作品名称</span><input autoFocus value={newProject.title} onChange={(event) => setNewProject({ ...newProject, title: event.target.value })} placeholder="例如：雾港来信" /></label>
      <label><span>类型</span><select value={newProject.projectType} onChange={(event) => setNewProject({ ...newProject, projectType: event.target.value as ProjectType })}><option value="novel">小说</option><option value="webnovel">网文</option><option value="screenplay">剧本</option><option value="other">其他</option></select></label>
      <label><span>一句话备注（可选）</span><textarea value={newProject.description} onChange={(event) => setNewProject({ ...newProject, description: event.target.value })} placeholder="只给自己看的简短说明" /></label>
      <p className="isolation-note">将创建独立的正文、记忆、对话、检索索引、历史和备份空间。</p>
      <div className="modal-actions"><button type="button" onClick={() => setCreateOpen(false)}>取消</button><button className="primary" type="submit">创建并开始写作</button></div>
    </form></Modal>}
  </div>
}
