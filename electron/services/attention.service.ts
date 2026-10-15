import { app, Notification, type BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import { oemConfig } from '@shared/oem-runtime'

const log = createLogger('attention')

/**
 * AttentionService — 提请用户关注
 *
 * 用途：当某些"用户应该看一眼"的事件（例如 Agent 任务结束）发生，
 * 而主窗口不在前台焦点时，通过任务栏 / Dock 上的视觉提示提醒用户。
 *
 * 跨平台策略：
 * - macOS  : Dock badge 圆点
 * - Windows: 任务栏图标闪烁 (flashFrame)
 * - Linux  : setBadgeCount(1)（仅在支持的桌面环境生效，如 Unity）
 *
 * 主窗口聚焦后会自动清除提示。
 */
class AttentionService {
  private mainWindow: BrowserWindow | null = null
  private active = false
  private permissionEnsured = false
  /**
   * 自维护的窗口聚焦状态——不依赖每次 win.isFocused() 的实时返回。
   *
   * 经验：生产模式下用户 Cmd+Tab 切走后，Agent 完成回调触发的瞬间，
   * win.isFocused() 与 focus/blur 事件看到的状态偶有不一致（疑似
   * Electron 焦点状态与 IPC 调度间的时序差），改成事件驱动更稳。
   */
  private focused = true

  /**
   * 绑定主窗口。窗口重建时可重复调用——focus/blur 监听器只挂在传入的
   * BrowserWindow 实例上，旧窗口对象会随 GC 回收，不会出现重复触发。
   */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
    this.focused = win.isFocused()
    log.info(`attention setMainWindow: initial focused=${this.focused}`)
    win.on('focus', () => {
      log.info('attention: window focused')
      this.focused = true
      this.clear()
    })
    win.on('blur', () => {
      log.info('attention: window blurred')
      this.focused = false
    })
  }

  /**
   * macOS 一次性通知权限引导。
   *
   * 背景：Electron 的 `dock.setBadge(text)` 在 macOS 上**必须**应用拥有"显示通知"
   * 权限才能生效（见 Electron 官方文档）。开发模式跑的是 Electron 二进制自身的
   * bundle id（com.github.Electron），多数开发机历史上已经被授权过；生产打包是
   * `com.sfterm.terminal`，是一个全新的 bundle，初始未授权——这就是"开发模式
   * dock badge 正常、打包后无效"的根因。
   *
   * 解决：首次启动时主动 show 一条说明通知，触发系统的权限请求弹窗。用户做完
   * 选择后系统会持久记住，后续 setBadge 即可正常工作。用 userData 下的 marker
   * 文件标记"已请求过"，避免每次启动都打扰用户。
   *
   * 注意：即便用户最终选择"不允许"，我们也写 marker——macOS 系统级也会记住该
   * 选择，重复 show 通知不会再次弹权限对话框，但会继续显示通知卡片，反而更烦。
   */
  ensurePermission(): void {
    if (this.permissionEnsured) return
    this.permissionEnsured = true
    if (process.platform !== 'darwin') return

    try {
      const markerPath = path.join(app.getPath('userData'), '.attention-notification-requested')
      if (fs.existsSync(markerPath)) {
        log.debug('notification permission already requested previously, skip')
        return
      }

      if (!Notification.isSupported()) {
        log.debug('Notification not supported on this platform')
        return
      }

      const brand = app.getLocale().startsWith('zh') ? oemConfig.brand.name.zh : oemConfig.brand.name.en
      const notif = new Notification({
        title: brand,
        body: '允许通知后，任务完成时 Dock 图标可以显示提醒角标。',
        silent: true,
      })
      notif.show()

      try {
        fs.writeFileSync(markerPath, new Date().toISOString())
      } catch (e) {
        log.warn('write notification permission marker failed:', e)
      }
      log.info('macOS notification permission requested (one-time)')
    } catch (e) {
      log.warn('ensurePermission failed:', e)
    }
  }

  /**
   * 提请用户关注。窗口当前聚焦则不做任何事——用户已经在看了。
   *
   * 焦点判断使用「双重确认」策略：
   * - 只有事件驱动状态（this.focused）和 win.isFocused() 同时为 true，
   *   才认为窗口在前台，跳过提醒。
   * - 任意一方认为窗口不在前台，即触发提醒。
   * 这样可避免 packaged 版中偶发的 focus/blur 事件时序延迟造成漏报。
   *
   * @param notification 可选。窗口不在前台时额外弹出系统通知。
   */
  async request(notification?: { title: string; body: string }): Promise<void> {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) {
      log.debug('attention.request skipped: no window')
      return
    }

    const nativeFocused = win.isFocused()
    log.info(`attention.request: event-focused=${this.focused}, native-focused=${nativeFocused}`)

    // 双重确认：两者都说 focused 才跳过；任一说 not focused 则触发
    if (this.focused && nativeFocused) {
      log.info('attention.request skipped: window is focused (both event and native agree)')
      return
    }

    if (notification && Notification.isSupported()) {
      log.info(`attention notification: title="${notification.title}"`)
      try {
        new Notification({ title: notification.title, body: notification.body, silent: false }).show()
      } catch (e) {
        log.warn('attention notification failed:', e)
      }
    } else if (notification) {
      log.warn('attention notification skipped: Notification.isSupported()=false')
    }

    this.active = true

    try {
      if (process.platform === 'darwin') {
        // 防御：用户按 Cmd+W 关到托盘时主进程会调 app.dock.hide()，
        // Dock 图标整个消失，setBadge 没视觉效果——重新 show 一下让
        // 图标带着角标出现。dock.show() 是异步的，必须 await，否则
        // 在 dock 真正显示前就 setBadge，badge 会丢失。
        // Cmd+Tab 走的常规后台场景 dock 一直可见，await 立即返回。
        const dockVisible = app.dock?.isVisible()
        log.info(`attention badge: dock=${!!app.dock}, dock.isVisible=${dockVisible}`)
        if (app.dock && !dockVisible) {
          try {
            await app.dock.show()
            log.info('attention badge: dock.show() completed')
          } catch (e) {
            log.warn('attention badge: dock.show failed:', e)
          }
        }
        // 圆点而非数字：我们不计数，只表达"有事情要看"
        app.dock?.setBadge('•')
        log.info('attention badge set (macOS dock)')
      } else if (process.platform === 'win32') {
        win.flashFrame(true)
        log.info('attention flash started (Windows)')
      } else {
        app.setBadgeCount(1)
        log.info('attention badge set (Linux)')
      }
    } catch (e) {
      log.warn('attention.request failed:', e)
    }
  }

  /**
   * 清除提示（窗口聚焦时自动调用，外部一般无需直接调）。
   */
  clear(): void {
    if (!this.active) return
    this.active = false

    const win = this.mainWindow
    try {
      if (process.platform === 'darwin') {
        app.dock?.setBadge('')
      } else if (process.platform === 'win32') {
        if (win && !win.isDestroyed()) win.flashFrame(false)
      } else {
        app.setBadgeCount(0)
      }
    } catch (e) {
      log.debug('attention.clear failed:', e)
    }
  }
}

export const attentionService = new AttentionService()
