export const handleBeforeClose = async (
  flush: (() => Promise<void>) | undefined,
  confirmClose: () => Promise<void>,
  cancelClose: () => Promise<void>
): Promise<{ closed: boolean; error?: unknown }> => {
  try {
    await flush?.()
    await confirmClose()
    return { closed: true }
  } catch (error) {
    await cancelClose()
    return { closed: false, error }
  }
}

export const flushBeforeNavigate = async (flush: (() => Promise<void>) | undefined, navigate: () => void): Promise<void> => {
  await flush?.()
  navigate()
}
