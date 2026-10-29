import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { handleModalEscape } from '../services/modal-escape'

export function Modal({ title, children, onClose, width = 520, closeOnEscape = false }: { title: string; children: React.ReactNode; onClose(): void; width?: number; closeOnEscape?: boolean }): React.JSX.Element {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!closeOnEscape) return
    // 捕获阶段：先于工作区的 Esc 处理
    const onKeyDown = (event: KeyboardEvent): void => { handleModalEscape(event, () => closeRef.current()) }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [closeOnEscape])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><X size={18} /></button></header>
      <div className="modal-body">{children}</div>
    </section>
  </div>
}
