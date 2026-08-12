import { X } from 'lucide-react'

export function Modal({ title, children, onClose, width = 520 }: { title: string; children: React.ReactNode; onClose(): void; width?: number }): React.JSX.Element {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button className="icon-button" onClick={onClose}><X size={18} /></button></header>
      <div className="modal-body">{children}</div>
    </section>
  </div>
}
