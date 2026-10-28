/**
 * 把 IPC 抛回渲染进程的错误转成作者看得懂的文案：
 * Electron 会把主进程错误包成 "Error invoking remote method 'x': Error: 原文"，这里去掉包装只保留原文。
 */
export const userErrorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error):\s*/, '')
}
