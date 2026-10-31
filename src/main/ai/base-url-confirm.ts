import { checkBaseUrl } from '../../shared/base-url'

/**
 * A·M1：测试连接要带 API Key 时，是否须先经作者确认。
 * 规范化规则（两侧都走 checkBaseUrl().url）：去首尾空白；scheme 与主机名小写（含 IDNA/全角映射）；去掉默认端口（http:80、https:443）；
 * 去掉 path 末尾的 /；保留 path 大小写与 query 原文；丢弃 #fragment。规范化后的字符串完全相同才算「同一地址」。
 * - 已保存地址缺失（首次保存前测试）→ 须确认（安全侧，待组长确认）。
 * - 任一侧无法通过校验 → 须确认。
 */
export const normalizeBaseUrlForCompare = (raw: string): string | undefined => {
  const checked = checkBaseUrl(raw)
  return checked.ok ? checked.url : undefined
}

export const baseUrlKeyDecision = (requestUrl: string, savedUrl: string | undefined): { needsConfirm: boolean; reason: 'same' | 'changed' | 'no-saved' } => {
  if (savedUrl === undefined) return { needsConfirm: true, reason: 'no-saved' }
  const a = normalizeBaseUrlForCompare(requestUrl)
  const b = normalizeBaseUrlForCompare(savedUrl)
  if (a !== undefined && a === b) return { needsConfirm: false, reason: 'same' }
  return { needsConfirm: true, reason: 'changed' }
}
