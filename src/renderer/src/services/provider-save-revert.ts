/**
 * P3：服务设置「保存」后地址栏（Base URL）该显示什么。
 * - 取消（main 弹确认框后作者点取消，providers:save 以 PROVIDER_SAVE_CANCELLED reject）：配置没变，地址栏回到已保存的值。
 * - 保存成功（含确认后保存）：地址栏是新填的值（随后 reload 从已保存配置刷新，也是新值）。
 * - 其他保存失败：地址栏保持作者新填的值，方便修改后重试。
 * 只管地址栏；名称、超时等其他字段不回滚，保持作者输入（它们没有确认框，取消后也未保存）。
 * 取消的识别沿用 SettingsScreen 现有方式：userErrorMessage(error) 含「已取消保存」（IPC 跨进程后 error.code 不保证保留）。
 */
export const PROVIDER_SAVE_CANCELLED_TEXT = '已取消保存'

export const isProviderSaveCancelledMessage = (message: string): boolean => message.includes(PROVIDER_SAVE_CANCELLED_TEXT)

export type ProviderSaveOutcome = 'saved' | 'cancelled' | 'failed'

export function baseUrlAfterProviderSave(outcome: ProviderSaveOutcome, typedBaseUrl: string, savedBaseUrl: string | undefined): string {
  if (outcome === 'cancelled' && savedBaseUrl !== undefined) return savedBaseUrl
  return typedBaseUrl
}
