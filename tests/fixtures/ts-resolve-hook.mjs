// P3 PR-2b 崩溃测试：让 node 直接运行产品 TS 源码（不打包）。
// 类型擦除用 Node 22 自带的 --experimental-transform-types；本钩子只负责把源码里的无扩展名相对导入（'./schema'）解析到 .ts 文件。
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier)) {
    try { return await next(specifier + '.ts', context) } catch { /* 回落到默认解析 */ }
  }
  return next(specifier, context)
}
`))
