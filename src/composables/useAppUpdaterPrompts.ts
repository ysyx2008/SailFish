import { useI18n } from 'vue-i18n'
import { toast } from './useToast'
import {
  hideUpdateNotify,
  patchUpdateNotify,
  showUpdateNotify,
} from './useUpdateNotify'
import { createLogger } from '../utils/logger'
import type { LocaleType } from '../i18n'
import { getChangelogPageUrl, getDownloadPageUrl } from '../config/urls'
import { getReleaseSummary } from '../utils/releaseMeta'

const log = createLogger('AppUpdater')

/**
 * 全局更新提醒（非打断右下角角标卡，不弹模态确认框），设计见 APP_UPDATE_SPEC.md
 * - 自动下载：全程不弹卡，下完才弹「可以安装了」
 * - 用户在提醒卡上点了「下载更新」：这次下载的进度留在卡上
 * - 后台检查 / 下载失败：不提示（用户亲手点的由各自当面处理）
 * - macOS 或关了自动下载：发现新版本时弹卡，由用户决定去下载
 */
export function useAppUpdaterPrompts() {
  const { t, locale } = useI18n()
  const isMac = /Mac/i.test(navigator.platform)
  const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

  let cleanup: (() => void) | null = null
  /** 用户关掉下载中卡片后，直到 ready 不再弹出 downloading */
  let hideDownloadingUntilReady = false
  /** 当前这次下载是用户在提醒卡上点出来的（只有这种下载才让卡陪着下） */
  let cardOwnsDownload = false
  /** 已为该 version 展示过 ready/available，避免状态抖动反复弹出 */
  let lastPresentedKey = ''

  function openChangelog(): void {
    const url = getChangelogPageUrl(locale.value as LocaleType)
    if (url) window.open(url, '_blank')
  }

  async function loadSummary(version: string): Promise<string> {
    try {
      return (await getReleaseSummary(version, locale.value as LocaleType)) || ''
    } catch {
      return ''
    }
  }

  async function isInstallOnQuitEnabled(): Promise<boolean> {
    const value = await window.electronAPI.config.get('installUpdateOnQuit') as boolean | undefined
    return value !== false
  }

  async function isAutoDownloadEnabled(): Promise<boolean> {
    const value = await window.electronAPI.config.get('autoDownloadUpdate') as boolean | undefined
    return value !== false
  }

  async function shouldSkipPrompt(version: string): Promise<boolean> {
    const dismissed = await window.electronAPI.config.get('dismissedUpdateVersion') as string | undefined
    return dismissed === version
  }

  async function snoozeVersion(version: string): Promise<void> {
    await window.electronAPI.config.set('dismissedUpdateVersion', version)
  }

  function presentKey(phase: string, version: string): string {
    return `${phase}:${version}`
  }

  async function dismissCard(version: string, phase: 'available' | 'downloading'): Promise<void> {
    hideUpdateNotify()
    if (phase === 'downloading') {
      // 仅藏卡，下载继续；就绪后仍会提醒安装
      hideDownloadingUntilReady = true
      return
    }
    // available：关闭 = 跳过这个版本的提醒
    await snoozeVersion(version)
    toast.info(t('about.updateSnoozedToast'), 5000)
  }

  /**
   * 「可以安装了」卡的三个关闭方式（退出时安装 / 稍后提醒 / 右上角关闭）都落在这里：这次先不重启。
   * 开着「退出时安装」就安排退出时装；没开则不记任何跳过，下次启动后再提醒。
   */
  async function postponeInstall(version: string, installOnQuitEnabled: boolean): Promise<void> {
    hideUpdateNotify()
    // 同步占位，避免随后 downloaded 事件抖动再次弹卡
    lastPresentedKey = presentKey('ready', version)
    if (!installOnQuitEnabled) {
      toast.info(t('about.updateRemindLaterToast'), 5000)
      return
    }
    const result = await window.electronAPI.updater.deferInstall()
    if (result.success) {
      toast.info(t('about.updateDeferredToast', { version }), 6000)
    } else {
      // 没安排成：放开占位，之后的「已下载」状态还能再把提醒带回来
      lastPresentedKey = ''
      toast.warning(result.error || t('about.updateError'))
    }
  }

  async function showAvailableCard(
    version: string,
    status: UpdateStatusInfo,
    options?: { force?: boolean },
  ): Promise<void> {
    if (await shouldSkipPrompt(version)) return
    const key = presentKey('available', version)
    if (!options?.force && key === lastPresentedKey) return
    lastPresentedKey = key

    const summary = await loadSummary(version)
    const installOnQuitEnabled = await isInstallOnQuitEnabled()

    showUpdateNotify(
      {
        phase: 'available',
        version,
        summary,
        isMac,
        installOnQuitEnabled,
        percent: 0,
        transferred: 0,
        total: 0,
      },
      {
        onPrimary: async () => {
          if (isMac) {
            const url = getDownloadPageUrl(locale.value as LocaleType)
            if (url) window.open(url, '_blank')
            hideUpdateNotify()
            return
          }
          const source = status.sources?.current ?? status.sources?.recommended
          // 立即切到下载中 UI，勿 await 整包下载（否则 available 卡会一直 primaryBusy 变灰）
          hideDownloadingUntilReady = false
          cardOwnsDownload = true
          lastPresentedKey = ''
          await showDownloadingCard(version, {
            status: 'downloading',
            info: { version },
            progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
            sources: status.sources,
          })
          const onDownloadFailed = async (message?: string): Promise<void> => {
            cardOwnsDownload = false
            lastPresentedKey = ''
            toast.warning(message || t('about.updateError'))
            // 用主进程最新状态重试（可能已切 fallback 源），避免闭包里的 available 过时
            const latest = await window.electronAPI.updater.getStatus().catch(() => status)
            void showAvailableCard(version, latest?.info?.version ? latest : status, { force: true })
          }
          void window.electronAPI.updater.downloadUpdate(source).then(
            // 成功：downloaded 事件切到 ready
            (result) => (result.success ? undefined : onDownloadFailed(result.error)),
            // 请求本身没送达（窗口销毁等）：同样当面说，别让卡停在「下载中」
            (err: unknown) => onDownloadFailed(err instanceof Error ? err.message : undefined),
          )
        },
        onSecondary: async () => {
          await dismissCard(version, 'available')
        },
        onChangelog: openChangelog,
        onDismiss: async () => {
          await dismissCard(version, 'available')
        },
      },
    )
  }

  async function showDownloadingCard(version: string, status: UpdateStatusInfo): Promise<void> {
    if (hideDownloadingUntilReady) return
    if (await shouldSkipPrompt(version)) return

    const key = presentKey('downloading', version)
    const progress = status.progress
    const percent = progress?.percent ?? 0
    const transferred = progress?.transferred ?? 0
    const total = progress?.total ?? 0

    if (key !== lastPresentedKey) {
      lastPresentedKey = key
      showUpdateNotify(
        {
          phase: 'downloading',
          version,
          summary: '',
          isMac: false,
          installOnQuitEnabled: await isInstallOnQuitEnabled(),
          percent,
          transferred,
          total,
        },
        {
          onPrimary: async () => {},
          onSecondary: async () => {},
          onChangelog: openChangelog,
          onDismiss: async () => {
            await dismissCard(version, 'downloading')
          },
        },
      )
      return
    }

    patchUpdateNotify({ percent, transferred, total })
  }

  async function showReadyCard(version: string): Promise<void> {
    const deferred = await window.electronAPI.updater.isInstallDeferred()
    if (deferred.deferred && deferred.version === version) {
      hideUpdateNotify()
      return
    }

    hideDownloadingUntilReady = false
    const key = presentKey('ready', version)
    if (key === lastPresentedKey) return
    lastPresentedKey = key

    if (isMac) {
      // Mac 无 quitAndInstall；force 展示「前往下载」，避免与先前 available 幂等键冲突导致漏弹
      await showAvailableCard(version, { status: 'available', info: { version } }, { force: true })
      return
    }

    const installOnQuitEnabled = await isInstallOnQuitEnabled()

    showUpdateNotify(
      {
        phase: 'ready',
        version,
        summary: '',
        isMac: false,
        installOnQuitEnabled,
        percent: 100,
        transferred: 0,
        total: 0,
      },
      {
        onPrimary: async () => {
          await window.electronAPI.updater.quitAndInstall()
        },
        // 「退出时安装」/「稍后提醒」/ 右上角关闭：同一件事——这次先不重启
        onSecondary: async () => {
          await postponeInstall(version, installOnQuitEnabled)
        },
        onChangelog: openChangelog,
        onDismiss: async () => {
          await postponeInstall(version, installOnQuitEnabled)
        },
      },
    )
  }

  async function handleStatus(status: UpdateStatusInfo): Promise<void> {
    const version = status.info?.version

    if (status.status === 'error') {
      // 后台检查 / 下载失败不打扰，下次检查再试。用户亲手点的下载与检查，失败由各自当面处理：
      // 「关于」页读同一份状态自己展示；提醒卡上点的下载由点击的返回结果处理（含换源重试）。
      log.warn('更新出错:', status.error)
      return
    }

    if (!version) return

    if (status.status === 'available') {
      // 这个版本这次启动里已经下完并提醒过了（比如用户关掉提醒后又手动点了检查更新）：不回头再弹「发现新版本」
      if (lastPresentedKey === presentKey('ready', version)) return
      if (isMac) {
        await showAvailableCard(version, status)
      } else if (!(await isAutoDownloadEnabled())) {
        await showAvailableCard(version, status)
      }
      return
    }

    if (status.status === 'downloading') {
      if (isMac) return
      // 只有用户在提醒卡上点了下载才让卡陪着下；自动下载、在「关于」里点的下载都不弹卡
      if (cardOwnsDownload) {
        await showDownloadingCard(version, status)
      } else if (lastPresentedKey === presentKey('available', version)) {
        // 用户转到别处（如「关于」页）点了下载：「发现新版本」卡已经没用了，收掉，免得再点一次重复下载
        hideUpdateNotify()
      }
      return
    }

    if (status.status === 'downloaded') {
      cardOwnsDownload = false
      await showReadyCard(version)
    }
  }

  function start(): void {
    if (isSteamBuild) return
    stop()

    cleanup = window.electronAPI.updater.onStatusChanged((status) => {
      void handleStatus(status).catch((err) => {
        log.warn('处理更新状态失败:', err)
      })
    })

    void window.electronAPI.updater.getStatus().then(async (status) => {
      await handleStatus(status)
    }).catch(() => { /* ignore */ })
  }

  function stop(): void {
    cleanup?.()
    cleanup = null
    hideUpdateNotify()
    lastPresentedKey = ''
    hideDownloadingUntilReady = false
    cardOwnsDownload = false
  }

  return { start, stop }
}
