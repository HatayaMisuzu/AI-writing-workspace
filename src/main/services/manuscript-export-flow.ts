import type { ExportOptions, ManuscriptExportResult } from '../../shared/export-range'

/**
 * P1-2 遗留修复：先校验范围与筛选结果，再弹保存框；筛选为空时不弹框、不写文件。
 * countChapters 抛错（范围越界等）会在弹保存框之前冒泡。
 */
export async function runManuscriptExport(deps: {
  countChapters(options: ExportOptions): number
  showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }>
  write(filePath: string, options: ExportOptions): Promise<void>
}, options: ExportOptions): Promise<ManuscriptExportResult> {
  if (deps.countChapters(options) === 0) return { status: 'empty' }
  const result = await deps.showSaveDialog()
  if (result.canceled || !result.filePath) return { status: 'canceled' }
  await deps.write(result.filePath, options)
  return { status: 'saved', filePath: result.filePath }
}
