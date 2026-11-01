import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusLockedProject, Project, ProjectType } from '../../shared/domain'
import { FocusLockNotice } from './components/Blackroom'
import { TitleBar } from './components/TitleBar'
import { WorksRail } from './components/WorksRail'
import { Modal } from './components/Modal'
import { LibraryScreen } from './screens/LibraryScreen'
import { WorkspaceScreen } from './screens/WorkspaceScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { flushBeforeNavigate, handleBeforeClose } from './services/close-handler'

type Screen = { type: 'library' } | { type: 'workspace'; projectId: string } | { type: 'settings' }

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [screen, setScreen] = useState<Screen>({ type: 'library' })
  const [createOpen, setCreateOpen] = useState(false)
  const [newProject, setNewProject] = useState<{ title: string; projectType: ProjectType; description: string }>({ title: '', projectType: 'novel', description: '' })
  const [appError, setAppError] = useState<string>()
  const [appNotice, setAppNotice] = useState<string>()
  const [blackroomLocked, setBlackroomLocked] = useState(false)
  const [lockedProjects, setLockedProjects] = useState<FocusLockedProject[]>([])
  const refreshLocked = useCallback(async (): Promise<void> => {
    try { setLockedProjects(await window.workspace.focus.lockedProjects()) } catch { /* 读不到锁状态不阻止写作 */ }
  }, [])
  const onFocusLockChange = useCallback((locked: boolean): void => { setBlackroomLocked(locked); void refreshLocked() }, [refreshLocked])
  const beforeLeaveRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const active = screen.type === 'workspace' ? projects.find((project) => project.id === screen.projectId) : undefined
  const reload = useCallback(async () => setProjects(await window.workspace.projects.list(true)), [])
  const registerBeforeLeave = useCallback((handler?: () => Promise<void>): void => { beforeLeaveRef.current = handler }, [])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    void refreshLocked()
    const timer = window.setInterval(() => void refreshLocked(), 2000)
    const onFocus = (): void => void refreshLocked()
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [refreshLocked, screen])

  useEffect(() => window.workspace.window.onBeforeClose(() => {
    void (async () => {
      const result = await handleBeforeClose(beforeLeaveRef.current, window.workspace.window.confirmClose, window.workspace.window.cancelClose)
      if (!result.closed) setAppError(`关闭前保存失败：${result.error instanceof Error ? result.error.message : String(result.error)}`)
    })()
  }), [])
  const navigate = useCallback(async (next: Screen): Promise<void> => {
    try { await flushBeforeNavigate(beforeLeaveRef.current, () => setScreen(next)) }
    catch (error) { setAppError(`尚未离开当前章节：${error instanceof Error ? error.message : String(error)}`) }
  }, [])
  const open = (project: Project): void => { void navigate({ type: 'workspace', projectId: project.id }) }
  const create = async (): Promise<void> => {
    if (!newProject.title.trim()) return
    try { await beforeLeaveRef.current?.() } catch (error) { setAppError(`创建新作品前保存失败：${error instanceof Error ? error.message : String(error)}`); return }
    const project = await window.workspace.projects.create(newProject)
    setCreateOpen(false); setNewProject({ title: '', projectType: 'novel', description: '' }); await reload(); open(project)
  }
  // P3 小黑屋只锁当前作品：只在作品库给一条轻提示（哪本在小黑屋 + 回去入口）；其他作品与设置里不显示全局锁提示
  const lockNotice = screen.type === 'library' ? lockedProjects : []
  const returnToLocked = (projectId: string): void => { void navigate({ type: 'workspace', projectId }) }
  const title = screen.type === 'library' ? '作品库' : screen.type === 'settings' ? '设置 · 模型与服务' : active ? `${active.title} · 写作` : '墨记'

  return <div className="app-shell">
    <TitleBar title={title} />
    {appError && <div className="app-error" role="alert"><span>{appError}</span><button onClick={() => setAppError(undefined)}>关闭</button></div>}
    {appNotice && <div className="app-notice" role="status" data-testid="app-notice"><span>{appNotice}</span><button onClick={() => setAppNotice(undefined)}>关闭</button></div>}
    <div className={blackroomLocked ? "app-body is-blackroom" : "app-body"}>
      {/* P3：锁定期间也保留作品栏，可以切换到其他作品；回到被锁作品时锁定照常 */}
      <WorksRail projects={projects.filter((project) => !project.archived)} activeId={active?.id} onLibrary={() => void navigate({ type: 'library' })} onOpen={open} onCreate={() => setCreateOpen(true)} onSettings={() => void navigate({ type: 'settings' })} onSearch={() => void navigate({ type: 'library' })} />
      <div className={lockNotice.length ? "screen-host has-lock-notice" : "screen-host"}>
        <FocusLockNotice locked={lockNotice} onReturn={returnToLocked} />
        {screen.type === 'library' ? <LibraryScreen projects={projects} lockedIds={new Set(lockedProjects.map((item) => item.projectId))} onOpen={open} onCreate={() => setCreateOpen(true)} onImport={async () => { const project = await window.workspace.backup.importProject(); if (project) { if (project.importNotice) setAppNotice(project.importNotice); await reload(); open(project) } }} onImportManuscript={async () => { const project = await window.workspace.backup.importManuscript(); if (project) { await reload(); open(project) } }} onArchive={async (project) => { await window.workspace.projects.archive(project.id, !project.archived); await reload() }} onBackup={(project) => void window.workspace.backup.exportProject(project.id)} onExport={(project, format, onlyFinal, range) => window.workspace.backup.exportManuscript(project.id, format, onlyFinal, range)} />
          : screen.type === 'settings' ? <SettingsScreen />
          : active ? <WorkspaceScreen key={active.id} project={active} onProjectChanged={() => void reload()} onSettings={() => void navigate({ type: 'settings' })} onRegisterBeforeLeave={registerBeforeLeave} onFocusLockChange={onFocusLockChange} />
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
