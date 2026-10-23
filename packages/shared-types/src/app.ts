/**
 * 应用级偏好：用户在设置里选、主进程与界面都要认的那几项。
 */

/** 界面语言 */
export type LocaleType = 'zh-CN' | 'en-US'

/** 日志级别（主进程与渲染进程各有各的 logger 实现，级别口径必须一致） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

/** 更新源 */
export type UpdateSource = 'github' | 'oss'

/** 退出前会被带走的东西：界面数好，主进程据此决定要不要问、怎么说 */
export interface QuitConfirmCounts {
  /** 还开着的终端（本机 + 远程），与侧栏「终端」上的数字一致 */
  terminals: number
  /** 界面上看得见、AI 还在干活的对话 */
  runningTasks: number
}
