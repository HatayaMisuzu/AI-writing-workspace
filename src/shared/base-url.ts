/** S1c：模型服务 Base URL 只允许 http/https。main（schema、存量配置、adapter）与 renderer（设置页即时提示）共用。 */
export const BASE_URL_MISSING_SCHEME = '请在地址前加 http:// 或 https://（例如 http://localhost:11434/v1）。'
export const BASE_URL_UNSUPPORTED_SCHEME = 'Base URL 只支持 http:// 或 https:// 地址。'
export const BASE_URL_HAS_CREDENTIALS = '地址中不要包含账号或密码，密钥请填在 Key 栏。'
export const BASE_URL_MALFORMED = 'Base URL 格式不正确。'

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; message: string }

export const checkBaseUrl = (raw: string): BaseUrlCheck => {
  const value = raw.trim()
  if (!value) return { ok: false, message: BASE_URL_MALFORMED }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // localhost:11434、127.0.0.1:8080/v1、api.example.com 等缺协议的写法
    if (!value.includes(':') || /^[^\s/:]+:\d+(\/|$)/.test(value)) return { ok: false, message: BASE_URL_MISSING_SCHEME }
    return { ok: false, message: BASE_URL_UNSUPPORTED_SCHEME }
  }
  let parsed: URL
  try { parsed = new URL(value) } catch { return { ok: false, message: BASE_URL_MALFORMED } }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: BASE_URL_UNSUPPORTED_SCHEME }
  if (parsed.username || parsed.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value)) return { ok: false, message: BASE_URL_HAS_CREDENTIALS }
  if (!parsed.hostname || /\s/.test(value)) return { ok: false, message: BASE_URL_MALFORMED }
  return { ok: true, url: value.replace(/\/+$/, '') }
}

/** 展示/回传给界面前隐去地址中的账号密码（存量配置可能含有），避免回显。 */
export const redactBaseUrl = (raw: string): string => raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1***@')
