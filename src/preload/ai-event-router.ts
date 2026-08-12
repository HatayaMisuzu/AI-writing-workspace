import type { AIStreamEvent } from '../shared/ipc'

export class AIEventRouter {
  private readonly listeners = new Map<string, (event: AIStreamEvent) => void>()

  register(requestId: string, listener: (event: AIStreamEvent) => void): () => void {
    this.listeners.set(requestId, listener)
    return () => this.listeners.delete(requestId)
  }

  dispatch(event: AIStreamEvent): void {
    this.listeners.get(event.requestId)?.(event)
    if (event.type === 'done' || event.type === 'error') this.listeners.delete(event.requestId)
  }
}
