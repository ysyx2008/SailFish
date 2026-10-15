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
 * 全局更新提醒（非打断右下角角标卡）
 * - 发现新版本 / 下载中 / 已就绪：更新角标卡，不弹模态确认框
 * - macOS：引导前往下载页；Win/Linux：下载或安装
 */
export function useAppUpdaterPrompts() {
  const { t, locale } = useI18n()
  const isMac = /Mac/i.test(navigator.platform)
  const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

  let cleanup: (() => void) | null = null
  /** 用户关掉下载中卡片后，直到 ready 不再弹出 downloading */
  let hideDownloadingUntilReady = false
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

  async function dismissCard(version: string, phase: 'available' | 'downloading' | 'ready'): Promise<void> {
    hideUpdateNotify()
    if (phase === 'downloading') {
      // 仅藏卡，下载继续；就绪后仍提示（除非用户再关掉并 snooze）
      hideDownloadingUntilReady = true
      return
    }
    // available / ready：关闭 = 稍后再说（不安排退出安装；要退出安装请点「退出时安装」）
    await snoozeVersion(version)
    toast.info(t('about.updateSnoozedToast'), 5000)
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
          lastPresentedKey = ''
          await showDownloadingCard(version, {
            status: 'downloading',
            info: { version },
            progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
            sources: status.sources,
          })
          void window.electronAPI.updater.downloadUpdate(source).then(async (result) => {
            if (!result.success) {
              lastPresentedKey = ''
              toast.warning(result.error || t('about.updateError'))
              // 用主进程最新状态重试（可能已切 fallback 源），避免闭包里的 available 过时
              const latest = await window.electronAPI.updater.getStatus().catch(() => status)
              void showAvailableCard(version, latest?.info?.version ? latest : status, { force: true })
            }
            // 成功：downloaded 事件切到 ready
          })
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
    if (await shouldSkipPrompt(version)) return

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
        onSecondary: async () => {
          if (installOnQuitEnabled) {
            const result = await window.electronAPI.updater.deferInstall()
            hideUpdateNotify()
            // 同步占位，避免随后 downloaded 事件抖动再次弹卡
            lastPresentedKey = presentKey('ready', version)
            if (result.success) {
              toast.info(t('about.updateDeferredToast', { version }), 6000)
            } else {
              toast.warning(t('about.updateError'))
            }
            return
          }
          // 未开启「退出时安装」时，次按钮即「稍后提醒」
          await dismissCard(version, 'ready')
        },
        onChangelog: openChangelog,
        onDismiss: async () => {
          await dismissCard(version, 'ready')
        },
      },
    )
  }

  async function handleStatus(status: UpdateStatusInfo): Promise<void> {
    const version = status.info?.version

    if (status.status === 'error') {
      hideUpdateNotify()
      hideDownloadingUntilReady = false
      // 放开幂等键，便于用户从「设置 → 关于」或下次 available 再试
      lastPresentedKey = ''
      toast.warning(status.error || t('about.updateError'))
      return
    }

    if (!version) return

    if (status.status === 'available') {
      if (isMac) {
        await showAvailableCard(version, status)
      } else if (!(await isAutoDownloadEnabled())) {
        await showAvailableCard(version, status)
      }
      return
    }

    if (status.status === 'downloading') {
      if (!isMac) {
        await showDownloadingCard(version, status)
      }
      return
    }

    if (status.status === 'downloaded') {
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
  }

  return { start, stop }
}
