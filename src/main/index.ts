import { installEgressGate, isFocusEgressLocked } from './net/egress-guard'
import { app, BrowserWindow, safeStorage, session, shell } from 'electron'
import { join } from 'node:path'
import { AppDatabase, QUIT_CLOSE_LIMIT_MS } from './database/database'
import { registerIpc } from './ipc/register'
import type { SecretCodec } from './ai/provider'
import { attachCloseHandshake } from './window-close'
import { shouldOpenExternal } from './external-url'
import { NetworkGate, originsFromProviderBaseUrls } from './network-policy'
import { DEV_DIAGNOSTICS_ARG } from '../shared/dev-diagnostics'

let database: AppDatabase | undefined
let networkGate: NetworkGate | undefined
/** 开发用诊断接口（preload __devWalCheckpoint + IPC diagnostics:wal-checkpoint）只在未打包时开启；打包版恒为 false，没有其他开关。 */
const devDiagnosticsEnabled = (): boolean => !app.isPackaged

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  function createWindow(): void {
    const win = new BrowserWindow({
      width: 1560, height: 980, minWidth: 1000, minHeight: 700, show: false,
      frame: false, backgroundColor: '#fffdf9', title: '墨记',
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
        // 开发用诊断接口只在未打包时让 preload 暴露（见 src/shared/dev-diagnostics.ts）；打包版不追加参数
        additionalArguments: devDiagnosticsEnabled() ? [DEV_DIAGNOSTICS_ARG] : []
      }
    })
    win.on('ready-to-show', () => win.show())
    win.webContents.on('will-navigate', (event) => { event.preventDefault() })
    attachCloseHandshake(win)
    win.webContents.setWindowOpenHandler(({ url }) => {
      // P3 小黑屋只锁当前作品：外链由系统浏览器打开，属「非作品」请求，不看锁（renderer 自身的网络策略不变）
      if (shouldOpenExternal(url, false)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  /** S2：从 provider_configs 刷新已保存 origin 白名单。 */
  const refreshNetworkAllowlist = (): void => {
    if (!database || !networkGate) return
    const rows = database.raw.prepare('SELECT base_url AS baseUrl FROM provider_configs').all() as Array<{ baseUrl: string }>
    networkGate.setSavedOrigins(originsFromProviderBaseUrls(rows.map((row) => row.baseUrl)))
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

    // S2 / §6：session.webRequest 白名单；开发态放行 devtools
    const isDev = Boolean(process.env.ELECTRON_RENDERER_URL) || !app.isPackaged
    networkGate = new NetworkGate({
      isDev,
      isFocusLocked: isFocusEgressLocked,
      onBlocked: (entry) => {
        console.warn(`[network-guard] blocked ${entry.reason}: ${entry.url}`)
      }
    })
    refreshNetworkAllowlist()
    // P3-1：主进程 Node fetch 不经 webRequest，统一经 egress-guard 同一门闸
    installEgressGate(networkGate)
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback(networkGate!.filter(details.url))
    })

    registerIpc(database, codec, {
      refreshNetworkAllowlist,
      allowOriginTemporarily: (origin) => networkGate!.allowTemporarily(origin),
      getBlockedLog: () => networkGate!.getBlockedLog()
    }, {
      // 诊断通道只在未打包（开发 / 测试 / e2e：直接跑 out/main/index.js）时注册；打包安装的生产构建 app.isPackaged=true，不注册。
      diagnostics: devDiagnosticsEnabled()
    })
    createWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
// P3 PR-2b：退出时先让后台 WAL 检查点 worker 跑完当前检查点并关闭自己的连接，再关主连接，然后真正退出。
// 上限 QUIT_CLOSE_LIMIT_MS（5s）：worker 段硬上限 5s − 预留（卡住就 terminate），预留段主连接退出前检查点 + close（P3 PR-53）。
// will-quit 在所有窗口关窗握手（渲染进程 flush 最后一次保存并提交）之后触发，所以退出前检查点排在最后一次保存提交之后。
// WAL ≤ WAL_QUIT_BOUND_BYTES 时总时长 < 5s；更大的 WAL 不保证 5s，但照常回写，已提交数据安全。
app.on('will-quit', (event) => {
  const db = database
  if (!db || db.closed) return
  event.preventDefault()
  database = undefined
  void db.closeForQuit(QUIT_CLOSE_LIMIT_MS)
    .then((result) => { if (result.timedOut) console.warn(`[wal-checkpoint] worker did not close within ${QUIT_CLOSE_LIMIT_MS}ms; terminated`) })
    .catch((error: unknown) => console.warn(`[wal-checkpoint] close failed: ${(error as Error).message}`))
    .finally(() => app.quit())
})
