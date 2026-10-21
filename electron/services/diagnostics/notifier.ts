/**
 * 崩溃提示 —— 崩溃后主动找用户，而不是等他翻设置页
 *
 * 用原生对话框而不是界面里的提示条：最该提示的场景恰恰是界面进程已经崩掉、
 * 界面里任何组件都弹不出来的时候。
 *
 * 防打扰优先于上报成功率。只有「界面不可用」和「上次异常退出」这两种用户
 * 本来就察觉到了的情况才打断他；子进程崩溃和主进程 JS 异常只记录不弹窗——
 * 用户看不见的部分不该打断他手上的活。同类问题短时间内只说一次，单次运行
 * 有次数上限，随时能永久关掉。面对一个已经被崩溃折磨够了的用户，宁可少收
 * 几份报告，也不能让提示变成新的骚扰。
 *
 * 设计目标见 SPEC.md。
 */
import { BrowserWindow, clipboard, dialog, webContents } from 'electron'
import type { CrashEvent, CrashStartupVerdict } from '@sailfish/shared-types'
import { t } from '../../i18n/main-i18n'
import { createLogger } from '../../utils/logger'
import { onCrashRecorded } from './collector'

const log = createLogger('Diagnostics')

/** 同类问题的最短提示间隔 */
const SAME_KIND_INTERVAL_MS = 5 * 60 * 1000
/** 单次运行最多打断用户几次 */
const MAX_PROMPTS_PER_RUN = 2

export interface CrashNotifierDeps {
  isEnabled: () => boolean
  setEnabled: (enabled: boolean) => void
  getSummaryText: () => Promise<string>
}

interface PromptOptions {
  /** 节流的分组键：同一类问题共用一个键 */
  key: string
  title: string
  message: string
  detail: string
  /** 要恢复的那个界面；给了才提供「重载界面」这个动作 */
  reloadTargetId?: number
}

export class CrashNotifier {
  private promptCount = 0
  private readonly lastPromptAt = new Map<string, number>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: CrashNotifierDeps) {}

  start(): void {
    this.stop()
    this.unsubscribe = onCrashRecorded(event => { void this.onCrash(event) })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** 上次崩溃的补报。必须等界面出来之后再调用，否则用户根本看不到弹窗 */
  async notifyPreviousCrash(verdict: CrashStartupVerdict): Promise<void> {
    if (!verdict.lastExitWasCrash) return
    const repeated = verdict.consecutiveCrashCount > 1
    await this.prompt({
      key: 'previous-exit',
      title: t('crash.previousTitle'),
      message: t('crash.previousMessage'),
      detail: repeated
        ? t('crash.previousDetailRepeated', { count: verdict.consecutiveCrashCount })
        : t('crash.previousDetail'),
    })
  }

  private async onCrash(event: CrashEvent): Promise<void> {
    // 只有窗口本身崩了用户才真的动不了。嵌入内容（产出物预览的 webview）崩溃
    // 在用户眼里是「预览坏了」，弹「界面已崩溃」既不准，重载还会白白清掉现场
    if (event.kind !== 'renderer-gone' || event.processType !== 'renderer') return
    await this.prompt({
      key: event.kind,
      title: t('crash.rendererTitle'),
      message: t('crash.rendererMessage'),
      detail: t('crash.rendererDetail'),
      reloadTargetId: event.webContentsId,
    })
  }

  private canPrompt(key: string): boolean {
    if (!this.deps.isEnabled()) return false
    if (this.promptCount >= MAX_PROMPTS_PER_RUN) return false
    const last = this.lastPromptAt.get(key)
    return last === undefined || Date.now() - last >= SAME_KIND_INTERVAL_MS
  }

  private async prompt(options: PromptOptions): Promise<void> {
    if (!this.canPrompt(options.key)) return
    this.promptCount += 1
    this.lastPromptAt.set(options.key, Date.now())

    const target = options.reloadTargetId !== undefined
      ? webContents.fromId(options.reloadTargetId)
      : undefined

    const buttons = [t('crash.copySummary')]
    const reloadIndex = target ? buttons.push(t('crash.reloadWindow')) - 1 : -1
    const dismissIndex = buttons.push(t('crash.dismiss')) - 1

    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    try {
      const result = await this.showBox(win, {
        type: 'warning',
        title: options.title,
        message: options.message,
        detail: options.detail,
        buttons,
        defaultId: 0,
        cancelId: dismissIndex,
        checkboxLabel: t('crash.stopNotifying'),
        checkboxChecked: false,
        noLink: true,
      })

      if (result.checkboxChecked) {
        this.deps.setEnabled(false)
        log.info('用户选择不再提示崩溃')
      }

      if (result.response === 0) {
        await this.copySummary(win)
      } else if (result.response === reloadIndex) {
        // 渲染进程死了但 webContents 对象还在，重载它即可恢复，不用重启整个应用
        target?.reload()
      }
    } catch (err) {
      log.error('崩溃提示弹出失败:', err)
    }
  }

  private async copySummary(win: BrowserWindow | undefined): Promise<void> {
    try {
      await clipboard.writeText(await this.deps.getSummaryText())
      // 复制要有回执：用户得知道自己已经拿到了、以及拿到的是什么
      await this.showBox(win, {
        type: 'info',
        title: t('crash.copiedTitle'),
        message: t('crash.copiedMessage'),
        buttons: [t('crash.dismiss')],
        noLink: true,
      })
    } catch (err) {
      log.error('复制崩溃摘要失败:', err)
    }
  }

  private showBox(
    win: BrowserWindow | undefined,
    options: Electron.MessageBoxOptions
  ): Promise<Electron.MessageBoxReturnValue> {
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  }
}
