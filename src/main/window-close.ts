import { BrowserWindow, dialog, type WebContents } from 'electron'

type CloseState = { allow: boolean; awaiting: boolean; timer?: ReturnType<typeof setTimeout> }
const states = new WeakMap<BrowserWindow, CloseState>()

export const attachCloseHandshake = (win: BrowserWindow): void => {
  const state: CloseState = { allow: false, awaiting: false }
  states.set(win, state)
  win.on('close', (event) => {
    if (state.allow) return
    event.preventDefault()
    if (state.awaiting) return
    state.awaiting = true
    win.webContents.send('window:before-close')
    state.timer = setTimeout(() => { void handleTimeout(win, state) }, 8_000)
  })
}

const handleTimeout = async (win: BrowserWindow, state: CloseState): Promise<void> => {
  if (win.isDestroyed() || !state.awaiting) return
  const result = await dialog.showMessageBox(win, {
    type: 'warning', title: '保存仍未完成', message: '编辑内容尚未确认保存。',
    detail: '返回编辑可以保留待保存内容；强制关闭可能丢失最后一次输入。',
    buttons: ['返回编辑', '仍然关闭'], defaultId: 0, cancelId: 0, noLink: true
  })
  if (result.response === 1) { state.allow = true; win.close() } else state.awaiting = false
}

const fromSender = (sender: WebContents): { win: BrowserWindow; state: CloseState } | undefined => {
  const win = BrowserWindow.fromWebContents(sender)
  if (!win) return undefined
  const state = states.get(win)
  return state ? { win, state } : undefined
}

export const confirmClose = (sender: WebContents): void => {
  const target = fromSender(sender)
  if (!target) return
  if (target.state.timer) clearTimeout(target.state.timer)
  target.state.allow = true
  target.win.close()
}

export const cancelClose = (sender: WebContents): void => {
  const target = fromSender(sender)
  if (!target) return
  if (target.state.timer) clearTimeout(target.state.timer)
  target.state.timer = undefined
  target.state.awaiting = false
}
