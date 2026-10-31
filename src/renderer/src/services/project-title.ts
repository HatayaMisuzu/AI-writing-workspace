/** 书名为空或只有空白时，前端统一显示「未命名作品」。只改显示，不写库。 */
export const UNTITLED_PROJECT_TITLE = '未命名作品'
export const displayProjectTitle = (title: string | null | undefined): string => (title ?? '').trim() ? title as string : UNTITLED_PROJECT_TITLE
