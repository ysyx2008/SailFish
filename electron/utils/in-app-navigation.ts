/**
 * 窗口里接下来要打开的地址留不留在应用内。
 * 开发服务器和本地文件留在窗口里；其余地址不在这个窗口里打开。
 * 主窗口和文件管理、调试、压测这几个窗口用同一条。
 */
export function shouldStayInApp(url: string, devServerUrl: string | undefined): boolean {
  if (devServerUrl && url.startsWith(devServerUrl)) return true
  return url.startsWith('file://')
}
