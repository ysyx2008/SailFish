/**
 * 编程技能 - 应用目录
 * 无头命令行（ELECTRON_RUN_AS_NODE）下拿不到 app，退回 undefined，让调用方接着找别处。
 */
import { app } from 'electron'

export function appPath(): string | undefined {
  try {
    return app?.getAppPath()
  } catch {
    return undefined
  }
}
