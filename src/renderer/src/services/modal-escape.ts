/** Esc 关闭对话框：只关闭本对话框，阻止事件继续冒泡到工作区（例如不会退出专注 / 小黑屋）。 */
export function handleModalEscape(event: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation' | 'isComposing'>, onClose: () => void): boolean {
  if (event.key !== 'Escape' || event.isComposing) return false
  event.preventDefault(); event.stopPropagation(); onClose()
  return true
}
