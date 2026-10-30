import { defineConfig } from 'vitest/config'

// H-W3：两个 WAL/检查点文件不与其他文件、也不彼此并行。
// 各自单独成 project，并用不同 sequence.groupOrder 依次在默认组之后运行（vitest 4）。
const walSerial = ['tests/checkpoint-release-p44.test.ts', 'tests/wal-checkpoint-p3.test.ts', 'tests/quit-budget-bench-diag.test.ts']

export default defineConfig({
  test: {
    environment: 'node',
    coverage: { reporter: ['text', 'html'] },
    projects: [
      {
        extends: true,
        test: { name: 'default', include: ['tests/**/*.test.ts'], exclude: walSerial, sequence: { groupOrder: 0 } }
      },
      {
        extends: true,
        test: { name: 'wal-serial-1', include: [walSerial[0]], sequence: { groupOrder: 1 } }
      },
      {
        extends: true,
        test: { name: 'wal-serial-2', include: [walSerial[1]], sequence: { groupOrder: 2 } }
      },
      {
        extends: true,
        // P3 PR-53 诊断（临时）
        test: { name: 'wal-serial-3', include: [walSerial[2]], sequence: { groupOrder: 3 } }
      }
    ]
  }
})
