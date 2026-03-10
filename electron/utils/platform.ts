/**
 * 跨平台工具函数
 */

/**
 * 获取当前系统的默认 Shell
 * - Windows: COMSPEC 环境变量 → cmd.exe
 * - Unix/Linux/macOS: SHELL 环境变量 → /bin/bash
 */
export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}
