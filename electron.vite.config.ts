import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/preload/index.ts'), output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    root: 'src/renderer',
    // 诊断分支：VITE_DIAG_KEYSTROKE=1 时换成 React profiling 构建，生产包里 <Profiler onRender> 才会回调
    resolve: { alias: [{ find: '@renderer', replacement: resolve('src/renderer/src') }, { find: '@shared', replacement: resolve('src/shared') }, ...(process.env.VITE_DIAG_KEYSTROKE === '1' ? [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] : [])] },
    plugins: [react()]
  }
})
