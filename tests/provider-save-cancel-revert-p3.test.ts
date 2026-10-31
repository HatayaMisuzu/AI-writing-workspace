/**
 * P3（B+，只改 renderer）：保存服务配置时作者在 main 确认框里点「取消」，地址栏回到已保存的值。
 * 确认后保存：地址栏是新值；其他保存失败：地址栏保持作者新填的值。
 * 取消识别沿用 SettingsScreen 现有方式：userErrorMessage(error) 含「已取消保存」。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { userErrorMessage } from '../src/shared/user-error'
import { baseUrlAfterProviderSave, isProviderSaveCancelledMessage } from '../src/renderer/src/services/provider-save-revert'

const SAVED = 'https://api.example.com/v1'
const TYPED = 'https://api.example.com/v2/other'
// 与 register.ts providers:save 取消时抛出的消息一致，并按 ipcRenderer.invoke 跨进程后的形状包一层
const cancelledIpcError = new Error("Error invoking remote method 'providers:save': Error: 已取消保存，服务配置未改动，API Key 不会发往新地址。")
const otherIpcError = new Error("Error invoking remote method 'providers:save': Error: 换了主机不能沿用已保存的 API Key，请重新填写。")

describe('取消保存后地址栏回到已保存的值', () => {
  it('取消：识别为取消，地址栏等于已保存的值', () => {
    const message = userErrorMessage(cancelledIpcError)
    expect(isProviderSaveCancelledMessage(message)).toBe(true)
    expect(baseUrlAfterProviderSave('cancelled', TYPED, SAVED)).toBe(SAVED)
  })

  it('确认后保存成功：地址栏是新值', () => {
    expect(baseUrlAfterProviderSave('saved', TYPED, SAVED)).toBe(TYPED)
  })

  it('其他保存失败：不识别为取消，地址栏保持作者新填的值', () => {
    expect(isProviderSaveCancelledMessage(userErrorMessage(otherIpcError))).toBe(false)
    expect(baseUrlAfterProviderSave('failed', TYPED, SAVED)).toBe(TYPED)
  })

  it('没有已保存值（新服务）时取消不会清空地址栏', () => {
    expect(baseUrlAfterProviderSave('cancelled', TYPED, undefined)).toBe(TYPED)
  })

  it('main 端取消消息仍含识别用文字（与 register.ts 对齐）', () => {
    const register = readFileSync(resolve('src/main/ipc/register.ts'), 'utf8')
    expect(register).toMatch(/new Error\('已取消保存[^']*'\), \{ code: 'PROVIDER_SAVE_CANCELLED' \}/)
  })

  it('源码守卫：SettingsScreen 取消分支只回滚地址栏（用已保存的 selected.baseUrl），其他失败照常抛出', () => {
    const screen = readFileSync(resolve('src/renderer/src/screens/SettingsScreen.tsx'), 'utf8')
    const branch = screen.slice(screen.indexOf('if (isProviderSaveCancelledMessage(userErrorMessage(error)))'), screen.indexOf('throw error', screen.indexOf('if (isProviderSaveCancelledMessage(userErrorMessage(error)))')))
    expect(branch).toContain("setForm((current) => ({ ...current, baseUrl: baseUrlAfterProviderSave('cancelled', current.baseUrl, savedBaseUrl) }))")
    expect(branch).toContain('const savedBaseUrl = selected?.baseUrl')
    expect(branch).toMatch(/return\s*\}/)
    expect(screen).not.toMatch(/userErrorMessage\(error\)\.includes\('已取消保存'\)/)
  })
})
