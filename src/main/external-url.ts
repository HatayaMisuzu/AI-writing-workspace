export const isAllowedExternalUrl = (raw: string): boolean => {
  try { const protocol = new URL(raw).protocol; return protocol === 'https:' || protocol === 'http:' }
  catch { return false }
}

/** window.open 外链交给系统浏览器前的判定。第二个参数为 true 时不打开；P3 起 main/index.ts 传 false（外链不受小黑屋影响）。 */
export const shouldOpenExternal = (raw: string, focusLocked: boolean): boolean => !focusLocked && isAllowedExternalUrl(raw)
