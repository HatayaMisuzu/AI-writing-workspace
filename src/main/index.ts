import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { AppDatabase } from './database/database'
import { registerIpc } from './ipc/register'
import type { SecretCodec } from './ai/provider'
import { attachCloseHandshake } from './window-close'
import { isAllowedExternalUrl } from './external-url'

let database: AppDatabase | undefined

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1560, height: 980, minWidth: 1100, minHeight: 700, show: false,
    frame: false, backgroundColor: '#fffdf9', title: '墨记',
    webPreferences: { preload: join(__dirname, '../preload/index.mjs'), sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  win.on('ready-to-show', () => win.show())
  attachCloseHandshake(win)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  database = new AppDatabase(join(app.getPath('userData'), 'inkstone.sqlite'))
  const codec: SecretCodec = {
    encrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE')
      return safeStorage.encryptString(value)
    },
    decrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE')
      return safeStorage.decryptString(value)
    }
  }
  registerIpc(database, codec)
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => database?.close())
