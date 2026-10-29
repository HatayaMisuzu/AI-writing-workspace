import { ZodError } from 'zod'

/** Hygiene：IPC 入参 zod 校验失败时返回中文可读报错，而不是 ZodError 的 JSON 原文。其他错误原样返回。 */
export const toUserFacingIpcError = (error: unknown): unknown => {
  if (!(error instanceof ZodError)) return error
  const fields = [...new Set(error.issues.map((issue) => issue.path.join('.') || '（整体）'))].slice(0, 5)
  return Object.assign(new Error(`请求参数无效：${fields.join('、')}。请刷新后重试。`), { code: 'IPC_INVALID_INPUT' })
}
