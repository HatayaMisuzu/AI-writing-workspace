import { Minus, Square, X } from 'lucide-react'

export function TitleBar({ title }: { title: string }): React.JSX.Element {
  return <header className="titlebar">
    <div className="brand-mark" aria-label="墨记"><span>墨</span></div>
    <div className="titlebar-title">{title}</div>
    <div className="window-controls">
      <button aria-label="最小化" onClick={() => void window.workspace.window.minimize()}><Minus size={16} /></button>
      <button aria-label="最大化" onClick={() => void window.workspace.window.toggleMaximize()}><Square size={13} /></button>
      <button className="window-close" aria-label="关闭" onClick={() => void window.workspace.window.close()}><X size={16} /></button>
    </div>
  </header>
}
