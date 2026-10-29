import { useState } from 'react'
import { Modal } from './Modal'

export function ConfirmAction({ title, message, onConfirm, children }: { title: string; message: string; onConfirm(): Promise<void>; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const confirmAction = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try { await onConfirm(); setOpen(false) }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)) }
    finally { setBusy(false) }
  }
  return <><button onClick={() => setOpen(true)}>{children}</button>{open && <Modal title={title} onClose={() => { if (!busy) setOpen(false) }}><p>{message}</p>{error && <div className="inline-error" role="alert">{error}</div>}<div className="modal-actions"><button disabled={busy} onClick={() => setOpen(false)}>取消</button><button className="primary" disabled={busy} onClick={() => void confirmAction()}>{busy ? '处理中…' : '确认'}</button></div></Modal>}</>
}
