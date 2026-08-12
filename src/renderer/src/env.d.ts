/// <reference types="vite/client" />
import type { WorkspaceApi } from '../../shared/ipc'

declare global {
  interface Window { workspace: WorkspaceApi }
}

export {}
