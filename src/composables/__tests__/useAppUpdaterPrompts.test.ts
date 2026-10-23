import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'zh-CN' } }),
}))
vi.mock('../useToast', () => ({ toast: toastMock }))
vi.mock('../../utils/releaseMeta', () => ({ getReleaseSummary: async () => '' }))
vi.mock('../../config/urls', () => ({
  getChangelogPageUrl: () => '',
  getDownloadPageUrl: () => '',
}))
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))

import { useAppUpdaterPrompts } from '../useAppUpdaterPrompts'
import { hideUpdateNotify, useUpdateNotify } from '../useUpdateNotify'

type Status = {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  info?: { version?: string }
  progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number }
  error?: string
}

const VERSION = '10.50.0'
const available: Status = { status: 'available', info: { version: VERSION } }
const downloading: Status = {
  status: 'downloading',
  info: { version: VERSION },
  progress: { percent: 42, bytesPerSecond: 1000, total: 600, transferred: 252 },
}
const downloaded: Status = { status: 'downloaded', info: { version: VERSION } }

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

interface Options {
  platform?: string
  autoDownload?: boolean
  installOnQuit?: boolean
  dismissedVersion?: string
  downloadResult?: { success: boolean; error?: string }
}

/** 起一份更新提醒，返回往里灌状态的办法和各个后端调用的记录 */
function setup(options: Options = {}) {
  vi.stubGlobal('navigator', { platform: options.platform ?? 'Win32' })
  const store: Record<string, unknown> = {
    autoDownloadUpdate: options.autoDownload ?? true,
    installUpdateOnQuit: options.installOnQuit ?? true,
    dismissedUpdateVersion: options.dismissedVersion,
  }
  let listener: ((status: Status) => void) | null = null
  const updater = {
    onStatusChanged: vi.fn((cb: (status: Status) => void) => {
      listener = cb
      return () => { listener = null }
    }),
    getStatus: vi.fn(async () => ({ status: 'idle' }) as Status),
    downloadUpdate: vi.fn(async () => options.downloadResult ?? { success: true }),
    isInstallDeferred: vi.fn(async () => ({ deferred: false, version: undefined })),
    deferInstall: vi.fn(async () => ({ success: true })),
    quitAndInstall: vi.fn(async () => ({ success: true })),
  }
  const config = {
    get: vi.fn(async (key: string) => store[key]),
    set: vi.fn(async (key: string, value: unknown) => { store[key] = value }),
  }
  vi.stubGlobal('window', { electronAPI: { updater, config }, open: vi.fn() })

  const prompts = useAppUpdaterPrompts()
  prompts.start()
  const card = useUpdateNotify()
  return {
    prompts,
    card,
    updater,
    config,
    emit: async (status: Status) => {
      listener?.(status)
      await flush()
    },
  }
}

describe('应用内更新提醒', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hideUpdateNotify()
  })
  afterEach(() => {
    hideUpdateNotify()
    vi.unstubAllGlobals()
  })

  describe('自动下载开着（Windows / Linux 默认）', () => {
    it('发现新版本和下载过程中都不弹卡，下完才弹「可以安装了」', async () => {
      const { card, emit } = setup()

      await emit(available)
      expect(card.model.visible).toBe(false)

      await emit(downloading)
      expect(card.model.visible).toBe(false)

      await emit(downloaded)
      expect(card.model.visible).toBe(true)
      expect(card.model.phase).toBe('ready')
    })

    it('后台检查或下载失败不弹任何提示，已经在的卡也不被收掉', async () => {
      const { card, emit } = setup()
      await emit(downloaded)
      expect(card.model.visible).toBe(true)

      await emit({ status: 'error', error: 'net::ERR_CONNECTION_RESET' })
      expect(toastMock.warning).not.toHaveBeenCalled()
      expect(card.model.visible).toBe(true)
    })

    it('下载失败（没有任何卡）同样无声', async () => {
      const { card, emit } = setup()
      await emit(available)
      await emit(downloading)
      await emit({ status: 'error', error: 'boom' })
      expect(toastMock.warning).not.toHaveBeenCalled()
      expect(card.model.visible).toBe(false)
    })
  })

  describe('关掉「可以安装了」', () => {
    it('开着退出时安装：右上角关闭 = 安排退出时安装，不记跳过', async () => {
      const { card, emit, updater, config } = setup({ installOnQuit: true })
      await emit(downloaded)

      await card.runDismiss()
      expect(updater.deferInstall).toHaveBeenCalledTimes(1)
      expect(toastMock.info).toHaveBeenCalledWith('about.updateDeferredToast', 6000)
      expect(config.set).not.toHaveBeenCalledWith('dismissedUpdateVersion', expect.anything())
      expect(card.model.visible).toBe(false)
    })

    it('开着退出时安装：「退出时安装」按钮和右上角关闭是同一件事', async () => {
      const { card, emit, updater } = setup({ installOnQuit: true })
      await emit(downloaded)

      await card.runSecondary()
      expect(updater.deferInstall).toHaveBeenCalledTimes(1)
      expect(card.model.visible).toBe(false)
    })

    it('没开退出时安装：关闭 = 这次先不装，不安排、不记跳过，并说明会再提醒', async () => {
      const { card, emit, updater, config } = setup({ installOnQuit: false })
      await emit(downloaded)

      await card.runDismiss()
      expect(updater.deferInstall).not.toHaveBeenCalled()
      expect(config.set).not.toHaveBeenCalledWith('dismissedUpdateVersion', expect.anything())
      expect(toastMock.info).toHaveBeenCalledWith('about.updateRemindLaterToast', 5000)
      expect(card.model.visible).toBe(false)
    })

    it('没开退出时安装：下次启动后同一版本还会再提醒', async () => {
      const first = setup({ installOnQuit: false })
      await first.emit(downloaded)
      await first.card.runDismiss()
      first.prompts.stop()

      const second = setup({ installOnQuit: false })
      await second.emit(downloaded)
      expect(second.card.model.visible).toBe(true)
      expect(second.card.model.phase).toBe('ready')
    })

    it('同一次启动里，关掉之后重复来的「已下载」状态不再弹', async () => {
      const { card, emit } = setup({ installOnQuit: false })
      await emit(downloaded)
      await card.runDismiss()

      await emit(downloaded)
      expect(card.model.visible).toBe(false)
    })

    it('以前在「发现新版本」卡上跳过过这个版本，不影响下完后的安装提醒', async () => {
      const { card, emit } = setup({ dismissedVersion: VERSION })
      await emit(downloaded)
      expect(card.model.visible).toBe(true)
    })

    it('退出时安装安排失败时当面说，并留着下一次状态把提醒带回来', async () => {
      const { card, emit, updater } = setup({ installOnQuit: true })
      updater.deferInstall.mockResolvedValueOnce({ success: false, error: '没有已下载的更新' })
      await emit(downloaded)

      await card.runDismiss()
      expect(toastMock.warning).toHaveBeenCalledWith('没有已下载的更新')
      expect(card.model.visible).toBe(false)

      await emit(downloaded)
      expect(card.model.visible).toBe(true)
      expect(card.model.phase).toBe('ready')
    })

    it('关掉提醒后又手动点了检查更新（同一版本再次「发现」）：不回头弹「发现新版本」', async () => {
      const { card, emit } = setup({ autoDownload: false, installOnQuit: false })
      await emit(available)
      await emit(downloading)
      await emit(downloaded)
      await card.runDismiss()
      expect(card.model.visible).toBe(false)

      await emit(available)
      expect(card.model.visible).toBe(false)
    })
  })

  describe('关了自动下载', () => {
    it('发现新版本弹卡；在卡上点下载，进度留在卡上，下完变成「可以安装了」', async () => {
      const { card, emit, updater } = setup({ autoDownload: false })

      await emit(available)
      expect(card.model.visible).toBe(true)
      expect(card.model.phase).toBe('available')

      await card.runPrimary()
      await flush()
      expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
      expect(card.model.phase).toBe('downloading')

      await emit(downloading)
      expect(card.model.phase).toBe('downloading')
      expect(card.model.percent).toBe(42)

      await emit(downloaded)
      expect(card.model.phase).toBe('ready')
    })

    it('不是在卡上点的下载（比如在「关于」里点的）不弹卡', async () => {
      const { card, emit } = setup({ autoDownload: false })

      await emit(downloading)
      expect(card.model.visible).toBe(false)
    })

    it('卡还开着、却转去「关于」里点了下载：「发现新版本」卡收掉，不留个能重复点的下载按钮', async () => {
      const { card, emit } = setup({ autoDownload: false })
      await emit(available)
      expect(card.model.phase).toBe('available')

      await emit(downloading)
      expect(card.model.visible).toBe(false)

      await emit(downloaded)
      expect(card.model.phase).toBe('ready')
    })

    it('卡上点的下载失败：当面提示，并把「下载更新」重新给出来', async () => {
      const { card, emit } = setup({
        autoDownload: false,
        downloadResult: { success: false, error: '两个源都下不动' },
      })
      await emit(available)

      await card.runPrimary()
      await flush()

      expect(toastMock.warning).toHaveBeenCalledWith('两个源都下不动')
      expect(card.model.visible).toBe(true)
      expect(card.model.phase).toBe('available')
    })

    it('卡上点了下载，请求本身没送达：当面提示，别让卡停在「下载中」', async () => {
      const { card, emit, updater } = setup({ autoDownload: false })
      updater.downloadUpdate.mockRejectedValue(new Error('Object has been destroyed'))
      await emit(available)

      await card.runPrimary()
      await flush()

      expect(toastMock.warning).toHaveBeenCalledWith('Object has been destroyed')
      expect(card.model.phase).toBe('available')
    })

    it('卡上点的下载中途某个源出错、换源重试：卡不消失', async () => {
      const { card, emit, updater } = setup({ autoDownload: false })
      // 下载一直挂着，模拟「第一个源失败后换第二个源还在下」
      updater.downloadUpdate.mockImplementation(() => new Promise(() => {}))
      await emit(available)
      await card.runPrimary()
      await flush()

      await emit({ status: 'error', error: '第一个源失败' })
      expect(toastMock.warning).not.toHaveBeenCalled()
      expect(card.model.visible).toBe(true)
      expect(card.model.phase).toBe('downloading')

      await emit(downloading)
      expect(card.model.phase).toBe('downloading')
    })

    it('用户关掉下载卡，下载继续，下完仍提醒安装', async () => {
      const { card, emit } = setup({ autoDownload: false })
      await emit(available)
      await card.runPrimary()
      await flush()

      await card.runDismiss()
      expect(card.model.visible).toBe(false)

      await emit(downloading)
      expect(card.model.visible).toBe(false)

      await emit(downloaded)
      expect(card.model.visible).toBe(true)
      expect(card.model.phase).toBe('ready')
    })
  })

  describe('macOS', () => {
    it('发现新版本弹卡，让用户去下载页；下载状态不弹卡', async () => {
      const { card, emit } = setup({ platform: 'MacIntel' })

      await emit(available)
      expect(card.model.visible).toBe(true)
      expect(card.model.isMac).toBe(true)

      hideUpdateNotify()
      await emit(downloading)
      expect(card.model.visible).toBe(false)
    })
  })
})
