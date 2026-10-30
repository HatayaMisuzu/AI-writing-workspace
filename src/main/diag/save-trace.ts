// DIAG（diag-save-after-replace 诊断分支专用，不合入）：主进程保存/事务/检查点打点。
// 只有环境变量 INKSTONE_DIAG_SAVE=1 时记录；时间为 performance.timeOrigin + performance.now()（墙钟 ms，与 renderer 同口径）。
// 不改变任何行为：只往内存数组里 push，读取走仅在开启时注册的 diagnostics:save-trace。
export const DIAG_SAVE = process.env.INKSTONE_DIAG_SAVE === '1'
export const diagNow = (): number => performance.timeOrigin + performance.now()
const events: Array<Record<string, unknown>> = []
export function diagMark(event: string, data: Record<string, unknown> = {}): void {
  if (!DIAG_SAVE) return
  events.push({ t: Math.round(diagNow() * 10) / 10, event, ...data })
  if (events.length > 5_000) events.splice(0, events.length - 5_000)
}
export function diagDrain(): Array<Record<string, unknown>> { return events.splice(0) }
