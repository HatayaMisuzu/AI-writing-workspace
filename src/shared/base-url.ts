/** S1c：模型服务 Base URL 只允许 http/https。main（schema、存量配置、adapter）与 renderer（设置页即时提示）共用。 */
export const BASE_URL_MISSING_SCHEME = '请在地址前加 http:// 或 https://（例如 http://localhost:11434/v1）。'
export const BASE_URL_UNSUPPORTED_SCHEME = 'Base URL 只支持 http:// 或 https:// 地址。'
export const BASE_URL_HAS_CREDENTIALS = '地址中不要包含账号或密码，密钥请填在 Key 栏。'
export const BASE_URL_MALFORMED = 'Base URL 格式不正确。'
export const BASE_URL_TOO_LONG = 'Base URL 过长（最多 2000 个字符）。'
export const BASE_URL_MAX_LENGTH = 2_000
// 零宽/不可见字符：可用于显示伪装（如 local\u200bhost 实际解析为 localhost）
const INVISIBLE_CHARS = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; message: string }

export const checkBaseUrl = (raw: string): BaseUrlCheck => {
  const value = raw.trim()
  if (!value) return { ok: false, message: BASE_URL_MALFORMED }
  if (raw.length > BASE_URL_MAX_LENGTH) return { ok: false, message: BASE_URL_TOO_LONG }
  if (INVISIBLE_CHARS.test(value)) return { ok: false, message: BASE_URL_MALFORMED }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // localhost:11434、127.0.0.1:8080/v1、api.example.com 等缺协议的写法
    if (!value.includes(':') || /^[^\s/:]+:\d+(\/|$)/.test(value)) return { ok: false, message: BASE_URL_MISSING_SCHEME }
    return { ok: false, message: BASE_URL_UNSUPPORTED_SCHEME }
  }
  let parsed: URL
  try { parsed = new URL(value) } catch { return { ok: false, message: BASE_URL_MALFORMED } }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: BASE_URL_UNSUPPORTED_SCHEME }
  if (parsed.username || parsed.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value)) return { ok: false, message: BASE_URL_HAS_CREDENTIALS }
  if (!parsed.hostname || /^\.*$/.test(parsed.hostname) || /\s/.test(value)) return { ok: false, message: BASE_URL_MALFORMED }
  // 存规范化后的地址（小写主机名、IDNA/全角映射后的真实主机），避免存入值与实际连接目标不一致
  const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`
  if (url.length > BASE_URL_MAX_LENGTH) return { ok: false, message: BASE_URL_TOO_LONG }
  return { ok: true, url }
}

/**
 * 隐去地址中的账号密码，不依赖写法是否标准（http:\\u:p@h、http:u:p@h、user:p@host 等）：
 * 协议（若有）及其后的斜杠/反斜杠之后、最后一个 @ 之前的内容全部替换为 ***。
 */
export const redactBaseUrl = (raw: string): string => {
  const at = raw.lastIndexOf('@')
  if (at < 0) return raw
  const prefix = /^\s*[a-z][a-z0-9+.-]*:[\\/]*/i.exec(raw)?.[0] ?? ''
  return `${prefix.length <= at ? prefix : ''}***${raw.slice(at)}`
}

/** 回传给界面的地址：校验不通过的一律不回显原文（只给出需修正提示），通过的再做脱敏兜底。 */
export const displayBaseUrl = (raw: string): string => checkBaseUrl(raw).ok ? redactBaseUrl(raw) : ''
