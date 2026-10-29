export const isAllowedExternalUrl = (raw: string): boolean => {
  try { const protocol = new URL(raw).protocol; return protocol === 'https:' || protocol === 'http:' }
  catch { return false }
}

/** F15：window.open 外链交给系统浏览器前的判定；小黑屋锁定期间一律不打开。 */
export const shouldOpenExternal = (raw: string, focusLocked: boolean): boolean => !focusLocked && isAllowedExternalUrl(raw)
