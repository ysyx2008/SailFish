<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, provide, watch, unref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Loader2, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { useTerminalStore, COMPANION_TAB_AGENT_ID } from './stores/terminal'
import { initSplitPaneHandler, disposeSplitPaneHandler } from './services/split-pane-handler'
import { initWorkbenchHandler, disposeWorkbenchHandler } from './services/workbench-handler'
import { useConfigStore, type SshSession } from './stores/config'
import TerminalTabView from './components/TerminalTabView.vue'
import { resolveWorkbenchRenderer, resolveWorkbenchKind, isWorkbenchAvailable } from './workbench/registry'
import { bootstrapWorkbenchCapabilities } from './workbench/bootstrap'
import { isOemFeatureEnabled } from '@shared/oem-features'
import SessionManager from './components/SessionManager.vue'
import AppSidebar from './components/AppSidebar.vue'
import TerminalPlaceEmpty from './components/TerminalPlaceEmpty.vue'
import SettingsModal from './components/Settings/SettingsModal.vue'
import FileExplorer from './components/FileExplorer/FileExplorer.vue'
import Awaken from './components/Awaken.vue'
import WatchPanel from './components/Awaken/WatchPanel.vue'
import WindowControls from './components/WindowControls.vue'
import SetupWizard from './components/SetupWizard.vue'
import WelcomePage from './components/WelcomePage.vue'
import SmartPatrolPage from './components/SmartPatrolPage.vue'
import TodoPanel from './components/Todo/TodoPanel.vue'
import Toast from './components/common/Toast.vue'
import UpdateNotifyCard from './components/common/UpdateNotifyCard.vue'
import ConfirmDialog from './components/common/ConfirmDialog.vue'
import SsoLoginGate from './components/Auth/SsoLoginGate.vue'
import { useConfirm, showConfirm } from './composables/useConfirm'
import { toast } from './composables/useToast'
import { useAuthStore } from './stores/auth'
import { checkAudioDevicesGlobal, initSpeechGlobal, refreshSpeechPackAvailability } from './composables/useSpeechRecognition'
import type { SftpConnectionConfig } from './composables/useSftp'
import { uiThemes } from './themes/ui-themes'
import { createLogger } from './utils/logger'
import { matchAccelerator, formatAccelerator } from './utils/shortcut'
import { closeFocusedArtifact } from '@sailfish/workbench-assistant/artifact'
import { isAssistantConversationSurfaceVisible } from './utils/agent-tab-ui-meta'
import { useAppUpdaterPrompts } from './composables/useAppUpdaterPrompts'
import { useShellNavigation } from './composables/useShellNavigation'
import { installUpdateNotifyPreviewGlobal } from './composables/previewUpdateNotify'
import {
  checkBondMilestonesOnStartup,
  showBondMilestoneToasts,
} from './composables/useBondMilestoneToasts'
import {
  notifyAgentCompleteCue,
  notifyAgentConfirmCue,
  notifyAgentFailedCue,
  notifyCompanionMessageCue,
} from './composables/useCueSound'

const log = createLogger('App')

const { t } = useI18n()

const authStore = useAuthStore()

// Steam 构建标识（由 vite define 注入），在 script 中取值供模板使用，避免模板直接访问全局
const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

/** 觉醒 / 关切：已拆成两个独立面板，OEM 特性各自控制入口 */
const canShowAwaken = !isSteamBuild && isOemFeatureEnabled('awaken')
const canShowWatch = !isSteamBuild && isOemFeatureEnabled('watch')

// 知识库索引重建状态
// cause 区分了为什么会重建，决定显示哪种文案：
//   - dimension_mismatch: 真正的模型升级（首次见的概率最低，但确实存在）
//   - data_corrupted    : 向量库损坏（manifest 指向不存在的 .lance 数据文件等）
//   - missing           : 索引缺失（首次启用 / 用户删过 lancedb 目录 / BM25 .json 丢失）
// ── 后端启动进度条（fixed overlay，不占 flex 空间）────────────────────────────
const startupLoading = ref(false)
const startupStage = ref('')
let cleanupStartupProgress: (() => void) | null = null
let startupDoneTimer: ReturnType<typeof setTimeout> | null = null
let startupFallbackTimer: ReturnType<typeof setTimeout> | null = null

const STARTUP_STAGE_LABELS: Record<string, string> = {
  plugins: '加载插件...',
  webSearch: '初始化搜索服务...',
  scheduler: '启动调度服务...',
  watchSensor: '启动 Watch/Sensor 服务...',
  migration: '执行数据迁移...',
  sensors: '启动传感器...',
  done: '初始化完成',
}

// ── 底部状态栏：知识库重建 / 备份 / 恢复（与启动进度共用同一条 bar）──────────
const _knowledgeDone = ref(true)  // 知识库是否空闲（默认不在补全索引）

const knowledgeLoading = computed(() => !_knowledgeDone.value)
const knowledgeLoadingText = ref('')
const knowledgeLoadingProgress = ref({ current: 0, total: 0, libraryTotal: 0, filename: '' })

// 启动 / 知识库 / 备份 共用一条底部状态栏，避免叠放闪两层
const bottomStatusVisible = computed(() =>
  !isSteamBuild && (startupLoading.value || knowledgeLoading.value),
)
/** 知识库/备份优先（更具体）；空闲时才回落到启动阶段文案 */
const bottomStatusShowingKnowledge = computed(() => knowledgeLoading.value)
const bottomStatusText = computed(() => {
  if (knowledgeLoading.value) {
    return knowledgeLoadingText.value || t('knowledge.repairing')
  }
  return startupStage.value || '后端服务启动中...'
})
const bottomStatusHasPercent = computed(() =>
  knowledgeLoading.value && knowledgeLoadingProgress.value.total > 0,
)
const bottomStatusPercent = computed(() => {
  const { current, total } = knowledgeLoadingProgress.value
  if (total <= 0) return 0
  return (current / total) * 100
})

let cleanupKnowledgeUpgrading: (() => void) | null = null
let cleanupKnowledgeProgress: (() => void) | null = null
let cleanupKnowledgeReady: (() => void) | null = null
let cleanupBackupStarted: (() => void) | null = null
let cleanupBackupCompleted: (() => void) | null = null
let cleanupRestoreStarted: (() => void) | null = null
let cleanupRestoreCompleted: (() => void) | null = null

function knowledgeText(cause?: 'dimension_mismatch' | 'data_corrupted' | 'missing') {
  switch (cause) {
    case 'dimension_mismatch': return t('knowledge.upgrading')
    case 'data_corrupted':     return t('knowledge.rebuilding')
    default:                   return t('knowledge.repairing')
  }
}
// ─────────────────────────────────────────────────────────────────────────────
const terminalStore = useTerminalStore()
const configStore = useConfigStore()

const { show: showConfirmDialog, options: confirmOptions, handleConfirm, handleCancel, handleNeutral, handleClose } = useConfirm()
const { start: startUpdaterPrompts, stop: stopUpdaterPrompts } = useAppUpdaterPrompts()

const showSidebar = ref(false)

// 欢迎页「最近对话」侧栏宽度（可拖拽调整，持久化到 config + localStorage 防 FOUC）
const DEFAULT_RECALL_SIDEBAR_WIDTH = 320
const MIN_RECALL_SIDEBAR_WIDTH = 240
const RECALL_SIDEBAR_WIDTH_STORAGE_KEY = 'sft-recall-sidebar-width'
const getMaxRecallSidebarWidth = () => Math.max(MIN_RECALL_SIDEBAR_WIDTH, window.innerWidth - 480)

function clampRecallSidebarWidth(width: number): number {
  return Math.min(getMaxRecallSidebarWidth(), Math.max(MIN_RECALL_SIDEBAR_WIDTH, width))
}

function readCachedRecallSidebarWidth(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_RECALL_SIDEBAR_WIDTH
    const raw = localStorage.getItem(RECALL_SIDEBAR_WIDTH_STORAGE_KEY)
    if (raw == null) return DEFAULT_RECALL_SIDEBAR_WIDTH
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return DEFAULT_RECALL_SIDEBAR_WIDTH
    return clampRecallSidebarWidth(parsed)
  } catch {
    return DEFAULT_RECALL_SIDEBAR_WIDTH
  }
}

function writeCachedRecallSidebarWidth(width: number): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(RECALL_SIDEBAR_WIDTH_STORAGE_KEY, String(width))
  } catch { /* localStorage 不可用时静默降级 */ }
}

const recallSidebarWidth = ref(readCachedRecallSidebarWidth())
const isRecallSidebarResizing = ref(false)
const recallSidebarCollapsed = ref(
  (() => { try { return localStorage.getItem('appSidebarCollapsed') === '1' || localStorage.getItem('recallSidebarCollapsed') === '1' } catch { return false } })()
)
const isRecallSidebarAnimating = ref(false)
let recallSidebarAnimTimer: ReturnType<typeof setTimeout> | null = null

watch(recallSidebarCollapsed, () => {
  isRecallSidebarAnimating.value = true
  if (recallSidebarAnimTimer) clearTimeout(recallSidebarAnimTimer)
  recallSidebarAnimTimer = setTimeout(() => {
    isRecallSidebarAnimating.value = false
    recallSidebarAnimTimer = null
  }, 400)
})

const showSettings = ref(false)
const showSmartPatrol = ref(false)
const showAwaken = ref(false)
const showWatchPanel = ref(false)
const watchPanelInitialTab = ref<string | undefined>(undefined)
const isAwakened = ref(false)

// 平台判断：macOS 使用 hiddenInset（左侧红绿灯），Windows 完全自绘标题栏（WindowControls 组件）
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const isWin = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)

// 全屏时红绿灯 / 自绘按钮都隐藏，header 不再需要预留空间
const isFullScreen = ref(false)

// Windows 汉堡菜单按钮 DOM 引用：用于在按钮位置弹出原生菜单 popup
const appMenuBtnRef = ref<HTMLButtonElement | null>(null)

// 打开应用菜单：渲染端把按钮的客户区坐标（左下角）传给主进程，主进程在该位置弹原生 Menu。
// 不传坐标时（如 Alt 键唤起且按钮已不可见），主进程会按鼠标位置兜底。
function openAppMenu(anchor?: HTMLElement) {
  if (!isWin) return
  let position: { x: number; y: number } | undefined
  if (anchor) {
    const rect = anchor.getBoundingClientRect()
    position = { x: rect.left, y: rect.bottom }
  }
  window.electronAPI.window.popupAppMenu?.(position)
}

function openAppMenuFromButton() {
  openAppMenu(appMenuBtnRef.value || undefined)
}

const hasTerminalTab = computed(() => terminalStore.tabs.some(t => t.type === 'local' || t.type === 'ssh'))

// UI 主题：使用 effectiveUiTheme 而非 uiTheme，这样在"跟随系统"模式下
// 系统外观切换时主题能立即反映出来（auto 下 effective = dark/light）
const currentUiTheme = computed(() => configStore.effectiveUiTheme)
// 当前主题的颜色模式（dark/light）
const currentColorScheme = computed(() => {
  const theme = uiThemes[currentUiTheme.value as keyof typeof uiThemes]
  return theme?.colorScheme || 'dark'
})
const settingsInitialTab = ref<string | undefined>(undefined)
const settingsInitialSection = ref<string | undefined>(undefined)
const pendingInstallSkillId = ref<string | undefined>(undefined)
const showFileExplorer = ref(false)
const sftpConfig = ref<SftpConnectionConfig | null>(null)
const showSetupWizard = ref(false)
/** 启动流程（配置加载、向导判定）结束后才允许欢迎页入场动画 */
const welcomeUiReady = ref(false)

// 每个终端 tab 对应的 TerminalTabView 实例引用（tabId -> instance）
const tabViewRefs = ref<Record<string, InstanceType<typeof TerminalTabView> | null>>({})

function setTabViewRef(tabId: string, el: unknown) {
  tabViewRefs.value[tabId] = (el as InstanceType<typeof TerminalTabView> | null) ?? null
}

function onAwakenClose(awakened?: boolean) {
  showAwaken.value = false
  if (typeof awakened === 'boolean') {
    isAwakened.value = awakened
    return
  }
  void window.electronAPI.config.get('agentAwakened')
    .then((value) => { isAwakened.value = !!value })
    .catch(() => { /* ignore */ })
}

function onWatchPanelClose() {
  showWatchPanel.value = false
  watchPanelInitialTab.value = undefined
}

// 提供给子组件
provide('showSettings', () => {
  showSettings.value = true
})
provide('openAppSettings', (tab?: string, section?: string) => {
  settingsInitialTab.value = tab || undefined
  settingsInitialSection.value = section || undefined
  showSettings.value = true
})

// 同步主题到 <html> 与 <body>：
// - <html>：CSS 变量从 :root 起作用，data-ui-theme 设在 html 上能让所有后代精确命中当前主题
// - <body>：让 Teleport 到 body 的弹窗也能继承正确主题
watch([currentUiTheme, currentColorScheme], ([theme, colorScheme]) => {
  document.documentElement.setAttribute('data-ui-theme', theme)
  document.documentElement.setAttribute('data-color-scheme', colorScheme)
  document.body.setAttribute('data-ui-theme', theme)
  document.body.setAttribute('data-color-scheme', colorScheme)
}, { immediate: true })

// Windows 标准：单独按下并松开 Alt 键弹出菜单栏（这里是汉堡菜单 popup）。
// 通过追踪"Alt 按下时是否被其他键打断"区分"Alt 单击"和"Alt+其他键加速键"。
// 注：右侧 AltGraph 用于输入特殊字符（如 €），不参与菜单唤起，与 Windows 系统行为一致
let altPressedAlone = false

// 是否有全屏 overlay 盖住主 header（汉堡按钮、自绘标题栏按钮均被遮住）
// SetupWizard / Awaken / WatchPanel / SettingsModal 都是 position:fixed inset:0 全屏覆盖
const isFullScreenOverlayOpen = computed(() =>
  showAwaken.value || showWatchPanel.value || showSettings.value || showSetupWizard.value
)

// 全局快捷键处理
const handleGlobalKeydown = (event: KeyboardEvent) => {
  const shortcuts = configStore.keyboardShortcuts

  // Alt 单击追踪：仅 Windows 启用。任何带其他修饰或与其他键组合的情况视为加速键，清除标记。
  // event.repeat 过滤连续触发（按住不放时浏览器会反复 keydown），保持语义清晰
  if (isWin) {
    if (event.key === 'Alt' && !event.repeat && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
      altPressedAlone = true
    } else {
      altPressedAlone = false
    }
  }

  if (matchAccelerator(event, shortcuts.newAssistantTab)) {
    event.preventDefault()
    newInPlace()
    return
  }

  if (matchAccelerator(event, shortcuts.newLocalTerminal)) {
    event.preventDefault()
    terminalStore.createTab('local')
    return
  }

  // 侧栏 ESC 关闭需让路给上层模态（如主机凭证弹窗），否则会与全局 listener 顺序叠加导致侧栏被误关
  if (event.key === 'Escape' && showSidebar.value) {
    if (document.querySelector('.credential-overlay, .session-modal')) return
    // 待办面自己分层处理 ESC（菜单 → 详情 → 离开），不要抢先关主机侧栏
    if (terminalStore.todosActive) return
    showSidebar.value = false
    return
  }

  // Ctrl+W / Cmd+W 关闭当前终端或窗口（不可自定义，始终生效）
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'w') {
    event.preventDefault()
    handleCloseShortcut()
  }

  if (shortcuts.navBack && matchAccelerator(event, shortcuts.navBack) && !isFullScreenOverlayOpen.value) {
    event.preventDefault()
    goBack()
    return
  }
  if (shortcuts.navForward && matchAccelerator(event, shortcuts.navForward) && !isFullScreenOverlayOpen.value) {
    event.preventDefault()
    goForward()
    return
  }

  // 分屏快捷键（默认值见 DEFAULT_KEYBOARD_SHORTCUTS，用户可在设置面板里改）
  // 默认 mac: ⌘D / ⌘⇧D / ⌘⇧W；默认 win/linux: Ctrl+Shift+D / E / W
  // 默认值用 Cmd / Ctrl 字面量（非 CmdOrCtrl）精确表达，避免 win 上 Ctrl+D 误吃 EOF
  handleSplitShortcut(event)
}

function handleMenuSplit(direction: 'horizontal' | 'vertical'): void {
  const tab = terminalStore.activeTab
  if (!tab || tab.type === 'assistant') return
  void terminalStore.splitTerminal(direction)
}

function handleSplitShortcut(event: KeyboardEvent): void {
  const tab = terminalStore.activeTab
  if (!tab || tab.type === 'assistant') return
  const shortcuts = configStore.keyboardShortcuts

  if (matchAccelerator(event, shortcuts.splitHorizontal)) {
    event.preventDefault()
    handleMenuSplit('horizontal')
    return
  }
  if (matchAccelerator(event, shortcuts.splitVertical)) {
    event.preventDefault()
    handleMenuSplit('vertical')
    return
  }
  // 关闭窗格只在已分屏时生效——单屏下走 Ctrl+W / Cmd+W（handleCloseShortcut）
  // 关 tab 的既有路径，避免覆盖用户对"关 tab"的预期
  if (matchAccelerator(event, shortcuts.closePane) && terminalStore.isSplitTab(tab)) {
    event.preventDefault()
    closeActivePane()
    return
  }
}

function closeActivePane(): void {
  const tab = terminalStore.activeTab
  if (!tab || !terminalStore.isSplitTab(tab)) return
  const activePtyId = terminalStore.getActivePtyId(tab)
  if (!activePtyId || !tab.splitLayout) return
  // 找到激活窗格的 paneId
  const findActivePaneId = (node: import('./stores/terminal').SplitPane): string | null => {
    if (node.type === 'terminal') return node.isActive ? node.id : null
    for (const c of node.children || []) {
      const r = findActivePaneId(c)
      if (r) return r
    }
    return null
  }
  const paneId = findActivePaneId(tab.splitLayout)
  if (paneId) {
    terminalStore.closePane(tab.id, paneId)
  }
}

const handleGlobalKeyup = (event: KeyboardEvent) => {
  if (!isWin) return
  // Alt 松开且全程未与其他键组合：弹出汉堡菜单（与 Windows 系统菜单栏 Alt 行为一致）
  if (event.key === 'Alt' && altPressedAlone) {
    altPressedAlone = false
    // 全屏 overlay 打开时按钮不可见，不主动唤起菜单（避免菜单弹在错误位置遮挡内容）
    if (isFullScreenOverlayOpen.value) return
    event.preventDefault()
    openAppMenu(appMenuBtnRef.value || undefined)
  }
}

// 处理关闭快捷键
const handleCloseShortcut = async () => {
  if (showFileExplorer.value) {
    closeSftp()
    return
  }
  const fileManagerClosed = await window.electronAPI.fileManager.close().catch(() => ({ closed: false }))
  if (fileManagerClosed?.closed) return
  const aiDebugClosed = await window.electronAPI.aiDebugCloseWindow().catch(() => ({ closed: false }))
  if (aiDebugClosed?.closed) return

  // 全屏覆盖面板（觉醒 / 关切 / 设置 / 控制面板）打开时，优先关闭它们
  if (showAwaken.value) {
    showAwaken.value = false
    return
  }
  if (showWatchPanel.value) {
    showWatchPanel.value = false
    return
  }
  if (showSettings.value) {
    showSettings.value = false
    return
  }
  if (showSmartPatrol.value) {
    showSmartPatrol.value = false
    return
  }

  // 产出物有焦点：先关当前页签，不关对话
  if (closeFocusedArtifact()) return

  const activeTab = terminalStore.activeTab
  if (activeTab) {
    if (activeTab.agentId === COMPANION_TAB_AGENT_ID) {
      // 联络常驻 tab 不可关闭：Cmd+W 退回欢迎页，不关窗口
      terminalStore.goToHome()
    } else if (activeTab.type === 'assistant' && !activeTab.isPromoted && !activeTab.isRemote) {
      // 普通本地助手 tab（未提升，理论上不应成为 activeTab）：隐藏窗口兜底
      await window.electronAPI.window.close()
    } else {
      // 终端 tab、已提升助手 tab、远程助手 tab：只关 tab，不关窗口
      await terminalStore.closeTab(activeTab.id)
    }
  } else if (terminalStore.todosActive) {
    // 待办固定面与联络一致：Cmd+W 退回欢迎页，不关窗口
    terminalStore.goToHome()
  } else if (terminalStore.terminalPlaceActive) {
    // 空终端页：与待办一样退回欢迎页，不关窗口
    terminalStore.goToHome()
  } else if (terminalStore.hubFocusedAssistantTabId) {
    // Hub 焦点模式（正在看某个对话）：Cmd+W 退回欢迎页，不关窗口
    terminalStore.goToHome()
  } else {
    // 任务首页（TabBar「任务」激活、无 Hub 焦点）→ 隐藏窗口
    await window.electronAPI.window.close()
  }
}

// macOS ⌘Q 防误触提示
const quitToastVisible = ref(false)
let cleanupQuitToast: (() => void) | null = null

// 清理函数存储
let cleanupTerminalCountListener: (() => void) | null = null
let cleanupMenuCommand: (() => void) | null = null
let cleanupSchedulerTaskStarted: (() => void) | null = null
let cleanupGatewayRemoteTab: (() => void) | null = null
let cleanupGatewayRemoteTask: (() => void) | null = null
let cleanupImConnectionChange: (() => void) | null = null
let cleanupImSendFailure: (() => void) | null = null
let cleanupAiProfileFallback: (() => void) | null = null
let cleanupRunTask: (() => void) | null = null
let cleanupInstallSkill: (() => void) | null = null
let cleanupWatchEnsureTab: (() => void) | null = null
let cleanupWatchProactiveMessage: (() => void) | null = null
let cleanupWatchActivateMessage: (() => void) | null = null
let cleanupAgentRunning: (() => void) | null = null
let cleanupAgentCompleteForProactive: (() => void) | null = null
let cleanupAgentErrorForTabAttention: (() => void) | null = null
let cleanupAgentNeedConfirmGlobal: (() => void) | null = null
let cleanupAgentConfirmResolvedGlobal: (() => void) | null = null
let cleanupFullScreenChange: (() => void) | null = null


onMounted(async () => {
  // 注册全局快捷键
  document.addEventListener('keydown', handleGlobalKeydown)
  document.addEventListener('keyup', handleGlobalKeyup)
  window.addEventListener('mouseup', handleMouseNav)

  // 注册分屏反向 IPC 处理器（响应主进程 Agent 工具的分屏调用）
  initSplitPaneHandler()
  initWorkbenchHandler()

  // ── 知识库 / 启动进度：必须最先订阅，绝不能被弹窗 await 堵住 ──────────────
  // 后端常在 Vue mount 前后就开始 rebuild；若等确认框点完再监听会漏掉全部进度。
  startupLoading.value = true
  cleanupStartupProgress = window.electronAPI.app.onStartupProgress(({ stage }) => {
    if (stage === 'done') {
      startupStage.value = STARTUP_STAGE_LABELS.done
      if (startupDoneTimer) clearTimeout(startupDoneTimer)
      startupDoneTimer = setTimeout(() => {
        startupLoading.value = false
        startupStage.value = ''
      }, 600)
    } else {
      startupStage.value = STARTUP_STAGE_LABELS[stage] ?? `${stage}...`
    }
  })
  startupFallbackTimer = setTimeout(() => { startupLoading.value = false }, 10_000)

  cleanupKnowledgeUpgrading = window.electronAPI.knowledge.onUpgrading((payload?: {
    cause?: 'dimension_mismatch' | 'data_corrupted' | 'missing'
    total?: number
    libraryTotal?: number
  }) => {
    _knowledgeDone.value = false
    knowledgeLoadingProgress.value = {
      current: 0,
      total: payload?.total ?? 0,
      libraryTotal: payload?.libraryTotal ?? 0,
      filename: '',
    }
    knowledgeLoadingText.value = knowledgeText(payload?.cause)
  })
  cleanupKnowledgeProgress = window.electronAPI.knowledge.onRebuildProgress((data) => {
    knowledgeLoadingProgress.value = {
      ...data,
      libraryTotal: data.libraryTotal ?? 0,
    }
  })
  cleanupKnowledgeReady = window.electronAPI.knowledge.onReady(() => {
    _knowledgeDone.value = true
    knowledgeLoadingProgress.value = { current: 0, total: 0, libraryTotal: 0, filename: '' }
    knowledgeLoadingText.value = ''
  })

  // SSO：features.sso 关闭时 no-op
  try {
    await authStore.init()
  } catch (e) {
    log.warn('auth init failed:', e)
  }

  // 同步全屏状态：初始查询 + 监听变化（macOS 全屏会隐藏红绿灯，需要调整 header 左侧留白）
  try {
    isFullScreen.value = await window.electronAPI.window.isFullScreen()
  } catch { /* ignore */ }
  cleanupFullScreenChange = window.electronAPI.window.onFullScreenChange((fs) => {
    isFullScreen.value = fs
  })

  // Windows 焦点恢复：用户点击输入元素时确保 webContents 拥有键盘焦点
  // 修复 Windows 上因 setAlwaysOnTop/通知交互导致的"输入框看似有焦点但无法键入"问题
  // 仅在渲染端确实无焦点时才请求：焦点正常时每次点击都调主进程 focus，
  // 会在激活态异常的窗口上反复扰动焦点，反而把"点不出光标"固化
  if (navigator.platform === 'Win32') {
    document.addEventListener('mousedown', (e) => {
      if (document.hasFocus()) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        window.electronAPI.window.focusWebContents()
      }
    }, true)
  }

  // 加载觉醒状态
  try {
    isAwakened.value = !!(await window.electronAPI.config.get('agentAwakened'))
  } catch { /* ignore */ }

  // 配置恢复提示：不 await，避免堵住后续初始化 / 知识库进度订阅已完成
  void (async () => {
    try {
      const recoveryNotice = await window.electronAPI.config.getRecoveryNotice()
      if (!recoveryNotice) return
      const isRestored = recoveryNotice.kind === 'restored'
      await showConfirm({
        type: 'warning',
        showCancel: false,
        title: isRestored
          ? t('dataSettings.configRestoredTitle')
          : t('dataSettings.configResetTitle'),
        message: isRestored
          ? t('dataSettings.configRestoredMessage')
          : t('dataSettings.configResetMessage'),
        confirmText: t('dataSettings.configRecoveryOk'),
      })
      await window.electronAPI.config.dismissRecoveryNotice()
    } catch { /* ignore */ }
  })()

  // 加载最近对话侧栏宽度（config 为真值；localStorage 仅用于首帧同步，避免启动时宽度跳变）
  try {
    const savedWidth = await window.electronAPI.config.get('recallSidebarWidth') as number | undefined
    if (typeof savedWidth === 'number' && Number.isFinite(savedWidth)) {
      const clamped = clampRecallSidebarWidth(savedWidth)
      recallSidebarWidth.value = clamped
      writeCachedRecallSidebarWidth(clamped)
    }
  } catch { /* ignore */ }

  // 加载最近对话侧栏折叠状态
  try {
    const savedCollapsed = await window.electronAPI.config.get('recallSidebarCollapsed') as boolean | undefined
    if (typeof savedCollapsed === 'boolean') {
      recallSidebarCollapsed.value = savedCollapsed
    }
  } catch { /* ignore */ }

  // 注册标签页数量查询响应（用于退出确认）
  // 只计「有意义」的 tab：终端、已提升助手 tab、运行中的 Hub 助手；纯空闲的 Hub 助手不计
  cleanupTerminalCountListener = window.electronAPI.window.onRequestTerminalCount(() => {
    const count = terminalStore.tabs.filter(t => {
      if (t.agentId === COMPANION_TAB_AGENT_ID) return false // 联络常驻 tab 不可关闭，不计入退出确认
      if (t.type !== 'assistant') return true           // 终端 tab 始终计
      if (t.isRemote || t.isPromoted) return true       // 远程 / 已提升助手计
      return t.agentState?.isRunning === true           // Hub 内运行中的助手计
    }).length
    window.electronAPI.window.responseTerminalCount(count)
  })

  // ── 备份 / 恢复进度（复用知识库进度条，无百分比，只显示文字）──────────────
  // 备份是文件级复制，无法中途报百分比；total 设为 0 时模板只显示文字
  cleanupBackupStarted = window.electronAPI.knowledge.onBackupStarted(() => {
    _knowledgeDone.value = false
    knowledgeLoadingProgress.value = { current: 0, total: 0, libraryTotal: 0, filename: '' }
    knowledgeLoadingText.value = t('knowledge.backup')
  })
  cleanupBackupCompleted = window.electronAPI.knowledge.onBackupCompleted((data) => {
    // 自动备份被 30min 间隔跳过时 skipped=true，静默关闭提示
    if (data.skipped) {
      _knowledgeDone.value = true
      knowledgeLoadingText.value = ''
      return
    }
    _knowledgeDone.value = true
    knowledgeLoadingProgress.value = { current: 0, total: 0, libraryTotal: 0, filename: '' }
    knowledgeLoadingText.value = ''
  })
  cleanupRestoreStarted = window.electronAPI.knowledge.onRestoreStarted(() => {
    _knowledgeDone.value = false
    knowledgeLoadingProgress.value = { current: 0, total: 0, libraryTotal: 0, filename: '' }
    knowledgeLoadingText.value = t('knowledge.restore')
  })
  cleanupRestoreCompleted = window.electronAPI.knowledge.onRestoreCompleted((data) => {
    if (data.success) {
      // 恢复成功后 initialize 会触发 rebuildStarted/rebuildProgress 继续显示增量补建进度，
      // 这里切到"恢复完成，正在补建"文案，等 rebuild/ready 事件接管
      knowledgeLoadingText.value = t('knowledge.restoreDone')
    } else {
      _knowledgeDone.value = true
      knowledgeLoadingProgress.value = { current: 0, total: 0, libraryTotal: 0, filename: '' }
      knowledgeLoadingText.value = ''
    }
  })
  // ──────────────────────────────────────────────────────────────────────────

  // 监听菜单命令
  cleanupMenuCommand = window.electronAPI.menu.onCommand(({ command }) => {
    handleMenuCommand(command)
  })

  // macOS ⌘Q 防误触：监听主进程的 Toast 显示/隐藏信号
  if (window.electronAPI.quit) {
    cleanupQuitToast = window.electronAPI.quit.onToast(({ show }) => {
      quitToastVisible.value = show
    })
  }

  // 监听定时任务开始事件，创建可见的终端 tab 并自动执行 Agent
  cleanupSchedulerTaskStarted = window.electronAPI.scheduler.onTaskStarted((data) => {
    if (data.ptyId) {
      // 根据任务类型构建 tab 配置，包含 pendingTask 以便 AiPanel 自动执行
      const tabTitle = `⏰ ${data.taskName}`
      const pendingTask = data.prompt  // 任务 prompt 作为待执行任务
      
      if (data.targetType === 'local') {
        terminalStore.createTabWithExistingPty({
          ptyId: data.ptyId,
          title: tabTitle,
          type: 'local',
          pendingTask
        })
      } else if (data.targetType === 'ssh' && data.sshSessionId) {
        // 获取 SSH 会话配置
        const sshSession = configStore.sshSessions.find(s => s.id === data.sshSessionId)
        if (sshSession) {
          terminalStore.createTabWithExistingPty({
            ptyId: data.ptyId,
            title: tabTitle,
            type: 'ssh',
            sshConfig: {
              host: sshSession.host,
              port: sshSession.port,
              username: sshSession.username
            },
            sshSessionId: data.sshSessionId,
            pendingTask
          })
        }
      }
      
      // 打开新 tab 的 AI 面板确保可见（createTabWithExistingPty 会激活新 tab）
      ensureAiPanel()
      
      log.debug(`[Scheduler] 定时任务开始: ${data.taskName}, 已创建终端 tab，等待 AiPanel 执行`)
    }
  })

  // 监听深链调起：从官网技能示例等外部来源触发 Agent 任务
  cleanupRunTask = window.electronAPI.app.onRunTask((task: string) => {
    log.debug(`[DeepLink] 收到外部任务: ${task.substring(0, 80)}...`)
    terminalStore.createTabWithTask(task)
    ensureAiPanel()
  })

  // 监听深链调起：从官网一键安装技能
  cleanupInstallSkill = window.electronAPI.app.onInstallSkill((skillId: string) => {
    log.debug(`[DeepLink] 收到技能安装请求: ${skillId}`)
    pendingInstallSkillId.value = skillId
    settingsInitialTab.value = 'skills'
    showSettings.value = true
  })

  // 监听远程 Gateway 助手标签页创建事件
  cleanupGatewayRemoteTab = window.electronAPI.gateway.onRemoteTabCreated((data) => {
    if (!data.agentId) return
    // Gateway Web 统一路由到联络常驻 tab
    if (data.agentId === COMPANION_TAB_AGENT_ID) {
      terminalStore.ensureCompanionTab()
      return
    }
    const existingTab = terminalStore.tabs.find(tab => tab.agentId === data.agentId)
    if (!existingTab) {
      terminalStore.createAssistantTab({
        agentId: data.agentId,
        title: data.title || t('gateway.remoteChat', '远程对话'),
        isRemote: true,
        activate: false
      })
      log.debug(`[Gateway] 远程助手标签页已创建: agentId=${data.agentId}`)
    }
  })

  // 监听远程 Gateway 任务开始事件：Toast 通知 + 设置 tab running 状态
  // 后端 WebChatService 直驱 Agent 执行，前端仅渲染
  cleanupGatewayRemoteTask = window.electronAPI.gateway.onRemoteTaskStarted((data) => {
    log.debug(`[WebChat] onRemoteTaskStarted: agentId=${data.agentId}, message="${data.message.substring(0, 60)}"`)
    const preview = data.message.length > 60
      ? data.message.substring(0, 60) + '...'
      : data.message
    const focusRemoteTab = () => {
      const tab = terminalStore.tabs.find(t => t.agentId === data.agentId)
      if (!tab) return
      if (tab.isPromoted || tab.isRemote) {
        terminalStore.setActiveTab(tab.id)
      } else {
        terminalStore.focusHubConversation(tab.id)
      }
    }
    toast.show(
      `📡 ${t('gateway.remoteTaskStarted')}: ${preview}`,
      'info',
      5000,
      true,
      { onClick: focusRemoteTab, action: t('common.view') }
    )

    // 找到或创建远程助手 tab
    let remoteTab = terminalStore.tabs.find(tab => tab.agentId === data.agentId)
    if (!remoteTab) {
      const newTabId = terminalStore.createAssistantTab({
        agentId: data.agentId,
        title: t('gateway.remoteChat', '远程对话'),
        isRemote: true,
        remoteChannel: data.remoteChannel,
        activate: false
      })
      terminalStore.markAssistantSkipOnboarding(newTabId)
      remoteTab = terminalStore.tabs.find(tab => tab.id === newTabId)
    } else if (data.remoteChannel) {
      remoteTab.remoteChannel = data.remoteChannel
    }
    if (remoteTab) {
      // 仅设置 running 状态，后端已在执行 Agent，steps 通过 agent:step IPC 事件流入
      terminalStore.setAgentRunning(remoteTab.id, true, data.agentId, data.message)
      log.debug(`[WebChat] 远程任务已开始: tabId=${remoteTab.id}, agentId=${data.agentId}`)
    }
  })

  // Watch desktop 输出：确保助手 tab 存在，后续 steps 通过标准 agent:step 事件流入
  cleanupWatchEnsureTab = window.electronAPI.watch.onEnsureTab((data) => {
    // 联络常驻 tab 已在 initializeApp 时创建，直接复用
    if (data.agentId === COMPANION_TAB_AGENT_ID) {
      terminalStore.ensureCompanionTab()
      return
    }
    const existing = terminalStore.tabs.find(t => t.agentId === data.agentId)
    if (!existing) {
      const tabId = terminalStore.createAssistantTab({
        agentId: data.agentId,
        title: `📡 ${t('watch.watchTabTitle', '关切')}`,
        isRemote: false,
        activate: false
      })
      terminalStore.markAssistantSkipOnboarding(tabId)
      log.debug(`[Watch] Created assistant tab: ${data.agentId}`)
    }
  })

  // 觉醒主动推送：收到消息先存着，弹通知；用户点击通知后才创建标签页展开对话
  const pendingProactiveMessages: Array<{ agentId: string; message: string; watchName: string; timestamp: number }> = []

  // 将 proactive 消息注入 tab steps 的辅助函数（单条 proactive_notice，不破坏任务分组）
  const injectProactiveSteps = (tabId: string, message: string, timestamp?: number) => {
    const ts = timestamp || Date.now()
    const uid = `proactive-${ts}-${Math.random().toString(36).substring(2, 6)}`
    terminalStore.addAgentStep(tabId, {
      id: `${uid}-notice`,
      type: 'proactive_notice',
      content: message,
      timestamp: ts
    })
  }

  const navigateToAgentTab = (tab: { id: string; isPromoted?: boolean; isRemote?: boolean }) => {
    if (tab.isPromoted || tab.isRemote) {
      terminalStore.setActiveTab(tab.id)
    } else {
      terminalStore.focusHubConversation(tab.id)
    }
  }

  const activateProactiveMessages = (agentId: string) => {
    const messages = pendingProactiveMessages.filter(m => m.agentId === agentId)
    if (messages.length === 0) {
      // 无待注入消息（消息已被 flushDeferredProactive 消费），但用户通过系统通知点击进来
      // 仍需导航到已有 tab，让用户能看到对话（否则点通知什么都不发生）
      const tab = terminalStore.tabs.find(t => t.agentId === agentId)
      if (tab) navigateToAgentTab(tab)
      return
    }

    let tab = terminalStore.tabs.find(t => t.agentId === agentId)
    if (!tab) {
      // companion tab 不存在时按远程对话创建，唯一性由 agentId 保证
      const tabId = terminalStore.createAssistantTab({
        agentId,
        title: t('gateway.remoteChat', '远程对话'),
        isRemote: true,
        activate: false
      })
      terminalStore.markAssistantSkipOnboarding(tabId)
      tab = terminalStore.tabs.find(t => t.id === tabId)
    }

    if (tab) {
      for (const msg of messages) {
        injectProactiveSteps(tab.id, msg.message, msg.timestamp)
      }
      // 用户主动点击 toast "查看"，注入后立即导航到对话
      navigateToAgentTab(tab)
    }

    // 清除已展示的消息
    pendingProactiveMessages.splice(0, pendingProactiveMessages.length,
      ...pendingProactiveMessages.filter(m => m.agentId !== agentId))
  }

  // Agent 完成时，将延迟的 proactive 消息注入 tab
  const flushDeferredProactive = (agentId: string) => {
    const tab = terminalStore.tabs.find(t => t.agentId === agentId)
    if (!tab) return
    const deferred = pendingProactiveMessages.filter(m => m.agentId === agentId)
    if (deferred.length === 0) return
    for (const msg of deferred) {
      injectProactiveSteps(tab.id, msg.message, msg.timestamp)
    }
    pendingProactiveMessages.splice(0, pendingProactiveMessages.length,
      ...pendingProactiveMessages.filter(m => m.agentId !== agentId))
    terminalStore.clearDeferredProactive(tab.id)
  }

  const resolveAgentEventTabId = (data: { agentId: string; ptyId?: string }): string | undefined => {
    if (data.ptyId) {
      return terminalStore.findTabIdByPtyId(data.ptyId)
        ?? terminalStore.findTabIdByAgentId(data.ptyId)
    }
    return terminalStore.findTabIdByAgentId(data.agentId)
  }

  // IM/WebChat 等外部入口触发 companion run 时同步桌面 tab isRunning
  cleanupAgentRunning = window.electronAPI.agent.onRunning?.((data: { agentId: string; ptyId?: string; userTask: string }) => {
    const tabId = resolveAgentEventTabId(data)
    if (!tabId) return
    terminalStore.setAgentRunning(tabId, true, data.agentId, data.userTask)
  }) || null

  // 全局兜底：多 tab 并行时将 needConfirm 写入正确 tab（与各 AiPanel 监听互补，避免路由遗漏）
  cleanupAgentNeedConfirmGlobal = window.electronAPI.agent.onNeedConfirm((data) => {
    const tabId = resolveAgentEventTabId(data)
    if (!tabId) return
    terminalStore.setAgentPendingConfirm(tabId, data)
    const tab = terminalStore.tabs.find(t => t.id === tabId)
    notifyAgentConfirmCue([data.agentId, data.ptyId, tab?.agentId])
  })

  cleanupAgentConfirmResolvedGlobal = window.electronAPI.agent.onConfirmResolved((data) => {
    const tabId = resolveAgentEventTabId(data)
    if (!tabId) return
    terminalStore.setAgentPendingConfirm(tabId, undefined)
  })

  // 全局监听 agent 完成事件：刷新延迟的 proactive + 后台 tab 标签栏提醒（microtask 晚于各 AiPanel 同步逻辑，可配合 skip）
  cleanupAgentCompleteForProactive = window.electronAPI.agent.onComplete((data: {
    agentId: string
    ptyId?: string
    pendingUserMessages?: Array<string | import('@shared/types').PendingUserHandoff>
    aborted?: boolean
    newBondMilestones?: string[]
    bondMetrics?: BondMetrics
  }) => {
    const completeTabId = resolveAgentEventTabId(data)
    const completeTab = completeTabId ? terminalStore.tabs.find(t => t.id === completeTabId) : undefined
    notifyAgentCompleteCue([data.agentId, data.ptyId, completeTab?.agentId], data.aborted)

    if (data.newBondMilestones?.length && data.bondMetrics) {
      void showBondMilestoneToasts(t, data.newBondMilestones, data.bondMetrics)
    }

    const tab = terminalStore.tabs.find(t => t.agentId === data.agentId)
    if (tab && terminalStore.hasDeferredProactive(tab.id)) {
      flushDeferredProactive(data.agentId)
    }

    const foundTabId = resolveAgentEventTabId(data)
    if (foundTabId) {
      terminalStore.finalizeAgentRunState(foundTabId)
    }

    queueMicrotask(() => {
      if (!foundTabId) return
      // 用户正在看这个对话（活跃 Tab 或任务区内 Hub 焦点），无需标记未读
      const isVisible = isAssistantConversationSurfaceVisible(
        foundTabId,
        terminalStore.conversationSurface
      )
      if (isVisible) return
      if (data.pendingUserMessages && data.pendingUserMessages.length > 0) return
      if (terminalStore.consumeAgentCompleteTabAttentionSkip(foundTabId)) return
      terminalStore.setAgentCompletedUnseen(foundTabId, true)
    })
  })

  // 后台 tab Agent 报错：收口运行状态 + 点亮标签栏（与 complete 兜底一致）
  cleanupAgentErrorForTabAttention = window.electronAPI.agent.onError((data: { agentId: string; ptyId?: string; aborted?: boolean }) => {
    const foundTabId = resolveAgentEventTabId(data)
    const errorTab = foundTabId ? terminalStore.tabs.find(t => t.id === foundTabId) : undefined
    if (!data.aborted) {
      notifyAgentFailedCue([data.agentId, data.ptyId, errorTab?.agentId])
    }
    if (foundTabId) {
      terminalStore.finalizeAgentRunState(foundTabId)
    }
    queueMicrotask(() => {
      if (!foundTabId) return
      const isVisible = isAssistantConversationSurfaceVisible(
        foundTabId,
        terminalStore.conversationSurface
      )
      if (isVisible) return
      terminalStore.setAgentCompletedUnseen(foundTabId, true)
    })
  })

  cleanupWatchProactiveMessage = window.electronAPI.watch.onProactiveMessage((data) => {
    notifyCompanionMessageCue()
    const preview = data.message.length > 100
      ? data.message.substring(0, 100) + '...'
      : data.message

    // 优先精确匹配 agentId，回退到 companion tab（IM 对话镜像）
    const tab = terminalStore.tabs.find(t => t.agentId === data.agentId)
      || terminalStore.tabs.find(t => t.agentId === COMPANION_TAB_AGENT_ID)

    if (tab) {
      const tabId = tab.id
      // Agent 忙时延迟注入，防止用户误回复干扰正在执行的任务
      const focusProactiveTab = (id: string) => {
        const t = terminalStore.tabs.find(t => t.id === id)
        if (!t) return
        navigateToAgentTab(t)
      }
      if (tab.agentState?.isRunning) {
        pendingProactiveMessages.push({
          agentId: data.agentId,
          message: data.message,
          watchName: data.watchName,
          timestamp: Date.now()
        })
        terminalStore.markDeferredProactive(tabId)
        toast.proactive(preview, () => focusProactiveTab(tabId))
      } else {
        injectProactiveSteps(tabId, data.message)
        toast.proactive(preview, () => focusProactiveTab(tabId))
      }
    } else {
      pendingProactiveMessages.push({
        agentId: data.agentId,
        message: data.message,
        watchName: data.watchName,
        timestamp: Date.now()
      })
      toast.proactive(preview, () => {
        activateProactiveMessages(data.agentId)
      })
    }
  })

  // 系统通知点击：激活应用并展开对话
  cleanupWatchActivateMessage = window.electronAPI.watch.onActivateMessage?.((data: { agentId: string }) => {
    activateProactiveMessages(data.agentId)
  }) || null

  // 全局监听 IM 渠道连接状态变化，弹 toast 通知
  const imPlatformNames: Record<string, string> = {
    dingtalk: t('settings.im.dingtalk'),
    feishu: t('settings.im.feishu'),
    slack: t('settings.im.slack'),
    telegram: t('settings.im.telegram'),
    wecom: t('settings.im.wecom'),
    wechat: t('settings.im.wechat'),
  }
  const imConnectedState = new Map<string, boolean>()
  cleanupImConnectionChange = window.electronAPI.im.onConnectionChange((data) => {
    const prev = imConnectedState.get(data.platform)
    imConnectedState.set(data.platform, data.connected)
    // 仅在状态真正变化时提示（跳过首次上报，避免启动时刷屏）
    if (prev === undefined) return
    const name = imPlatformNames[data.platform] || data.platform
    if (data.connected) {
      toast.success(t('im.channelConnected', { platform: name }))
    } else {
      toast.warning(t('im.channelDisconnected', { platform: name }))
    }
  })

  cleanupImSendFailure = window.electronAPI.im.onSendFailure((data) => {
    if (data.platform === 'wechat') {
      toast.warning(t('im.wechatSendFailed'), 8000)
    }
  })

  // AI 配置 id 失效并已回退时 toast 提醒（步骤流内另有 Agent 提示）
  cleanupAiProfileFallback = window.electronAPI.ai.onProfileFallback((notice) => {
    toast.warning(t('ai.profileFallback', { name: notice.usedName }), 6000)
  })

  // 加载配置
  await configStore.loadConfig()

  // 检查是否完成首次设置（Steam 版跳过引导向导）
  const setupCompleted = await window.electronAPI.config.getSetupCompleted()
  if (!setupCompleted) {
    if (isSteamBuild) {
      await configStore.setSetupCompleted(true)
    } else {
      showSetupWizard.value = true
      welcomeUiReady.value = true
      return // 显示向导，暂不创建终端
    }
  }

  // 已完成设置，正常启动
  await initializeApp()
  welcomeUiReady.value = true

  void checkBondMilestonesOnStartup(t)

  // 全局更新提醒（右下角非打断角标卡）
  startUpdaterPrompts()
  // DEV：DevTools 可调 window.__sailfishPreviewUpdateNotify('ready' | 'downloading' | 'available')
  installUpdateNotifyPreviewGlobal()
})

// 初始化应用（正常启动流程）
const initializeApp = async () => {
  // 确保「联络」常驻 tab 存在
  terminalStore.ensureCompanionTab()

  // 工作台声明的 MCP / skills 装配（内置多为空操作）
  void bootstrapWorkbenchCapabilities().catch((e) => {
    log.warn('Workbench bootstrap failed', e)
  })

  // 不再自动创建本地终端，显示欢迎页让用户选择

  // 延迟连接 MCP 服务器，不阻塞首屏渲染
  // 使用 requestIdleCallback 或 setTimeout 在浏览器空闲时执行
  const connectMcpServers = async () => {
    try {
      const results = await window.electronAPI.mcp.connectEnabledServers()
      const connected = results.filter(r => r.success).length
      const failed = results.filter(r => !r.success)
      if (connected > 0) {
        log.info(`[MCP] 自动连接了 ${connected} 个服务器`)
      }
      if (failed.length > 0) {
        log.warn('[MCP] 部分服务器连接失败:', failed)
      }
    } catch (error) {
      log.error('[MCP] 自动连接服务器失败:', error)
    }
  }

  // 延迟执行，让 UI 先渲染完成
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => connectMcpServers(), { timeout: 3000 })
  } else {
    setTimeout(connectMcpServers, 500)
  }

  // 全局音频设备检测：轻量同步操作，立即执行让用户尽早知道有无麦克风
  // pack 状态尽早刷新（供 PTT 门控）；worker 预加载仅在 pack 已装时走空闲
  if (configStore.keyboardShortcuts.voiceInput) {
    checkAudioDevicesGlobal().then(available => {
      if (!available) {
        toast.warning(t('ai.noAudioDevice'))
        return
      }
      void refreshSpeechPackAvailability().then((packOk) => {
        if (!packOk) return
        const preloadSpeech = () => {
          initSpeechGlobal().catch(err => log.warn('[Speech] 空闲预加载失败，将在首次使用时按需加载:', err))
        }
        if ('requestIdleCallback' in window) {
          requestIdleCallback(() => { void preloadSpeech() }, { timeout: 8000 })
        } else {
          setTimeout(() => { void preloadSpeech() }, 5000)
        }
      })
    })
  }
}

/**
 * Hub 主区当前渲染的 tab：activeTabId（终端/远程助手/已提升助手）优先，
 * 其次是 Hub 焦点会话（本地未提升助手，停留首页视图）。
 */
const activeSurfaceTabId = computed(
  () => terminalStore.activeTabId || terminalStore.hubFocusedTab?.id || ''
)
const shellPlace = computed(() => terminalStore.shellPlace)
const showTerminalEmpty = computed(() =>
  !showSmartPatrol.value && shellPlace.value === 'terminal' && !terminalStore.tabs.some(t =>
    t.id === terminalStore.activeTabId && (t.type === 'local' || t.type === 'ssh')
  )
)
const showTerminalTabStrip = computed(() =>
  shellPlace.value === 'terminal' && terminalStore.terminalTabs.length > 0
)
// 是否显示欢迎页：任务区且没有任何 surface tab、且非待办/巡检/空终端页
const showWelcomePage = computed(() =>
  !showSmartPatrol.value &&
  !terminalStore.todosActive &&
  !showTerminalEmpty.value &&
  !activeSurfaceTabId.value
)
/**
 * 主区要不要壳层顶条：欢迎页 / 空终端 / 待办自己没有第一排，需要一条透明区兜住窗口拖拽。
 * 终端页 / 助手 / 巡检各栏自己的顶栏贴窗口上沿，窗口按钮浮在第一排右侧，由该排让位。
 */
const needsShellTop = computed(() =>
  showWelcomePage.value ||
  showTerminalEmpty.value ||
  terminalStore.todosActive
)
/** 主工作区显示某个 tab 工作台（欢迎页 / 智能巡检 / 待办 / 空终端时隐藏，但 tab 组件保持挂载） */
const showTabWorkbench = computed(
  () => !showSmartPatrol.value && !terminalStore.todosActive && !showWelcomePage.value && !showTerminalEmpty.value
)
// 主导航侧栏：未收起时始终在
const showRecallSidebar = computed(() => !recallSidebarCollapsed.value)

// 主机管理侧栏：叠在主导航侧栏上时与它同宽，独占最左时用默认宽度
const hostSidebarWidth = computed(() =>
  showRecallSidebar.value ? `${recallSidebarWidth.value}px` : 'var(--sidebar-width)'
)

const sidebarToggleAttention = computed(() =>
  recallSidebarCollapsed.value && (
    terminalStore.hasTasksAreaAttention ||
    terminalStore.hasCompanionAttention ||
    terminalStore.hasTerminalPlaceAttention
  )
)
/** 欢迎页是否真正展示给用户（启动完成 + 无全屏遮挡），用于控制首次启动入场动画 */
const welcomePageReady = computed(
  () => welcomeUiReady.value && showWelcomePage.value && !isFullScreenOverlayOpen.value
)
/**
 * 从欢迎页打开助手：新会话走 Hub 焦点流，在侧栏最近对话里有位置、可切换、可退回。
 * 不能提升为独立 tab —— 顶栏 Tab 条已撤，提升出来的助手页没有任何标签归属。
 */
const openAssistantFromWelcome = () => {
  if (!isWorkbenchAvailable('assistant')) return
  const id = terminalStore.createAssistantTab({ activate: false })
  terminalStore.focusHubConversation(id)
}

/** 新建快捷键：在当前这个地方新建一个——终端里开本机终端，其他地方回到新对话的空白起点 */
const newInPlace = () => {
  if (terminalStore.shellPlace === 'terminal' || !isWorkbenchAvailable('assistant')) {
    if (isWorkbenchAvailable('local')) terminalStore.createTab('local')
    return
  }
  terminalStore.goToHome()
}

// 从欢迎页打开本地终端
const openLocalFromWelcome = async () => {
  if (!isWorkbenchAvailable('local')) return
  await terminalStore.createTab('local')
}

// 从欢迎页连接 SSH
const openSshFromWelcome = async (session: SshSession) => {
  if (!isWorkbenchAvailable('ssh')) return
  // 更新最近使用时间
  await configStore.updateSessionLastUsed(session.id)
  
  // 获取有效的跳板机配置
  const jumpHost = configStore.getEffectiveJumpHost(session)
  
  await terminalStore.createTab('ssh', {
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    privateKeyPath: session.privateKeyPath,  // 私钥文件路径
    passphrase: session.passphrase,  // 私钥密码
    jumpHost,
    encoding: session.encoding || 'utf-8',
    sessionId: session.id  // 传递会话 ID（用于重连）
  })
}

// 从欢迎页打开会话管理器：用户意图明确是挑主机连接，直接开主机管理，不绕经空终端页
const openSessionManagerFromWelcome = () => {
  openHostSidebar()
}

// 从欢迎页打开智能巡检
const openSmartPatrolFromWelcome = () => {
  terminalStore.todosActive = false
  showSmartPatrol.value = true
}

// 从欢迎页打开独立关切面板（默认进运营总览页）
const openWatchesFromWelcome = () => {
  if (!canShowWatch) return
  showAwaken.value = false
  watchPanelInitialTab.value = 'overview'
  showWatchPanel.value = true
}

// 从智能巡检返回欢迎页
const backFromSmartPatrol = () => {
  showSmartPatrol.value = false
}

// 完成引导向导
const onSetupComplete = async () => {
  showSetupWizard.value = false
  // 向导完成后留在欢迎页；诞生引导由欢迎页「初次见面」提示由用户选择启动
  await initializeApp()
  startUpdaterPrompts()
}

async function onSsoSoftLogin() {
  try {
    await authStore.login()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t('sso.loginFailed'))
  }
}

async function onSsoSoftLogout() {
  await authStore.logout()
  toast.success(t('sso.logoutDone'))
}

// 切换主机管理侧栏（欢迎页上以叠加层盖住最近对话侧栏）
const toggleSidebar = () => {
  showSidebar.value = !showSidebar.value
}

const openHostSidebar = () => {
  showSidebar.value = true
}

const { canGoBack, canGoForward, goBack, goForward } = useShellNavigation(showSmartPatrol)
const navBackShortcut = computed(() => formatAccelerator(configStore.keyboardShortcuts.navBack))
const navForwardShortcut = computed(() => formatAccelerator(configStore.keyboardShortcuts.navForward))

/** 离开待办：回到刚离开的界面；没有历史则回任务区 */
function closeTodosPanel() {
  if (canGoBack.value) {
    goBack()
    return
  }
  terminalStore.focusTaskArea()
}

function handleMouseNav(e: MouseEvent) {
  if (isFullScreenOverlayOpen.value) return
  if (e.button === 3) {
    e.preventDefault()
    goBack()
  } else if (e.button === 4) {
    e.preventDefault()
    goForward()
  }
}

const toggleRecallSidebarCollapsed = () => {
  recallSidebarCollapsed.value = !recallSidebarCollapsed.value
  try {
    localStorage.setItem('appSidebarCollapsed', recallSidebarCollapsed.value ? '1' : '0')
    // 旧键只写不读，为的是用户降级回旧版本时侧栏状态还在；等不再支持降级即可删
    localStorage.setItem('recallSidebarCollapsed', recallSidebarCollapsed.value ? '1' : '0')
  } catch { /* ignore */ }
  window.electronAPI.config.set('appSidebarCollapsed', recallSidebarCollapsed.value).catch(() => {})
}

const handleRecallSidebarResize = (e: MouseEvent) => {
  if (!isRecallSidebarResizing.value) return
  recallSidebarWidth.value = clampRecallSidebarWidth(e.clientX)
}

const stopRecallSidebarResize = () => {
  if (!isRecallSidebarResizing.value) return
  isRecallSidebarResizing.value = false
  document.removeEventListener('mousemove', handleRecallSidebarResize)
  document.removeEventListener('mouseup', stopRecallSidebarResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  writeCachedRecallSidebarWidth(recallSidebarWidth.value)
  window.electronAPI.config.set('recallSidebarWidth', recallSidebarWidth.value).catch(() => {})
}

const startRecallSidebarResize = (_e: MouseEvent) => {
  isRecallSidebarResizing.value = true
  document.addEventListener('mousemove', handleRecallSidebarResize)
  document.addEventListener('mouseup', stopRecallSidebarResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

type ChatToggleView = {
  toggleAiPanel?: () => void
  ensureAiPanel?: () => void
  showAiPanel?: unknown
  hasDeskChatToggle?: unknown
  deskChat?: { seated: boolean; visible: boolean }
}

function getChatToggleView(tabId?: string): ChatToggleView | null {
  const id = tabId || activeSurfaceTabId.value
  if (!id) return null
  return (tabViewRefs.value[id] as ChatToggleView | null) ?? null
}

const toggleAiPanel = () => {
  getChatToggleView()?.toggleAiPanel?.()
}

const aiPanelVisible = computed(() => {
  const view = getChatToggleView()
  if (view?.deskChat) return view.deskChat.visible
  return !!unref(view?.showAiPanel)
})

const showAiPanelToggle = computed(() => {
  if (isSteamBuild) return false
  if (showTerminalTabStrip.value) return true
  return !!getChatToggleView()?.deskChat?.seated
})

function ensureAiPanel(tabId?: string) {
  getChatToggleView(tabId)?.ensureAiPanel?.()
}

// 打开 SFTP 文件管理器（模态框模式）
const openSftp = (session: SshSession) => {
  sftpConfig.value = {
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    privateKeyPath: session.privateKeyPath,
    passphrase: session.passphrase
  }
  showFileExplorer.value = true
}

// 关闭 SFTP 文件管理器
const closeSftp = () => {
  showFileExplorer.value = false
  sftpConfig.value = null
}

// 有新的 Agent 任务时确保对应 tab 的 AI 面板可见
watch(() => Object.keys(terminalStore.pendingSchedulerTasks), (tabIds) => {
  for (const tabId of tabIds) {
    ensureAiPanel(tabId)
  }
})

// 从最近对话点开终端会话：切过去还得把 AI 侧栏掀开，否则看不到那条对话
watch(() => terminalStore.terminalAiPanelRevealSeq, () => {
  const tabId = terminalStore.terminalAiPanelRevealTabId
  if (!tabId) return
  nextTick(() => ensureAiPanel(tabId))
})

// 同步终端标签页状态到菜单栏（控制文件管理器等菜单项的启用/禁用）
watch(hasTerminalTab, (val) => {
  window.electronAPI.menu.setTerminalState(val)
}, { immediate: true })

watch(showAiPanelToggle, (val) => {
  window.electronAPI.menu.setAiPanelState(val)
}, { immediate: true })

const openConnectionSettings = (tab?: string) => {
  settingsInitialTab.value = tab || undefined
  settingsInitialSection.value = undefined
  showSettings.value = true
}

// 关闭控制面板
const closeSettings = () => {
  showSettings.value = false
  settingsInitialTab.value = undefined
  settingsInitialSection.value = undefined
  pendingInstallSkillId.value = undefined
}

// 重新运行引导
const restartSetup = async () => {
  showSetupWizard.value = true
}

// 处理菜单命令
const handleMenuCommand = async (command: string) => {
  // 需要主界面可见的命令，先关闭设置面板
  const requiresMainView = [
    'goNewChat', 'goCompanion', 'goTerminal', 'openTodos', 'openWatch',
    'newLocalTerminal', 'newAssistantTab', 'newSshConnection', 'manageHosts',
    'openFileManager', 'importXshell', 'closeTab',
    'toggleSidebar', 'toggleAiPanel',
    'clearTerminal', 'selectAll', 'batchCommand',
    'splitHorizontal', 'splitVertical', 'closePane',
    'navBack', 'navForward',
  ]
  if (showSettings.value && requiresMainView.includes(command)) {
    closeSettings()
  }

  switch (command) {
    case 'goNewChat':
      if (!isSteamBuild && isWorkbenchAvailable('assistant')) terminalStore.goToHome()
      break
    case 'goCompanion':
      if (!isSteamBuild && isWorkbenchAvailable('companion')) terminalStore.focusCompanionPlace()
      break
    case 'goTerminal':
      if (isWorkbenchAvailable('local') || isWorkbenchAvailable('ssh')) {
        terminalStore.focusTerminalPlace()
      }
      break
    case 'openTodos':
      if (!isSteamBuild) terminalStore.openTodos()
      break
    case 'openWatch':
      if (!isSteamBuild) openWatchesFromWelcome()
      break
    case 'navBack':
      goBack()
      break
    case 'navForward':
      goForward()
      break
    case 'newLocalTerminal':
      terminalStore.createTab('local')
      break
    case 'newAssistantTab':
      newInPlace()
      break
    case 'newSshConnection':
      terminalStore.focusTerminalPlace()
      openHostSidebar()
      break
    case 'manageHosts':
      toggleSidebar()
      break
    case 'openFileManager':
      window.dispatchEvent(new CustomEvent('menu:open-file-manager'))
      break
    case 'importXshell':
      openHostSidebar()
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('menu:import-xshell'))
      }, 100)
      break
    case 'splitHorizontal':
      handleMenuSplit('horizontal')
      break
    case 'splitVertical':
      handleMenuSplit('vertical')
      break
    case 'closePane':
      closeActivePane()
      break
    case 'closeTab':
      handleCloseShortcut()
      break
    case 'toggleSidebar':
      toggleRecallSidebarCollapsed()
      break
    case 'toggleAiPanel':
      if (!isSteamBuild) toggleAiPanel()
      break
    case 'toggleKnowledge':
      if (!isSteamBuild) {
        settingsInitialTab.value = 'knowledge'
        showSettings.value = true
      }
      break
    case 'openSettings':
      showSettings.value = true
      break
    case 'showAbout':
      settingsInitialTab.value = 'about'
      showSettings.value = true
      break
    case 'checkUpdate':
      settingsInitialTab.value = 'about'
      showSettings.value = true
      setTimeout(() => {
        window.electronAPI.updater.checkForUpdates()
      }, 500)
      break
    case 'restartAndUpdate':
      window.electronAPI.updater.quitAndInstall()
      break
    case 'clearTerminal':
      window.dispatchEvent(new CustomEvent('menu:clear-terminal'))
      break
    case 'selectAll':
      window.dispatchEvent(new CustomEvent('menu:select-all'))
      break
    case 'batchCommand':
      window.dispatchEvent(new CustomEvent('toggle-batch-panel'))
      break
    case 'openAiDebugConsole':
      if (!isSteamBuild) window.electronAPI.aiDebugOpenWindow()
      break
    case 'openLlmBenchConsole':
      if (!isSteamBuild) window.electronAPI.llmBenchOpenWindow()
      break
  }
}

onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeydown)
  document.removeEventListener('keyup', handleGlobalKeyup)
  window.removeEventListener('mouseup', handleMouseNav)
  disposeSplitPaneHandler()
  disposeWorkbenchHandler()
  // 清理监听器
  cleanupTerminalCountListener?.()
  cleanupStartupProgress?.()
  if (startupDoneTimer) { clearTimeout(startupDoneTimer); startupDoneTimer = null }
  if (startupFallbackTimer) { clearTimeout(startupFallbackTimer); startupFallbackTimer = null }
  cleanupKnowledgeUpgrading?.()
  cleanupKnowledgeProgress?.()
  cleanupKnowledgeReady?.()
  cleanupBackupStarted?.()
  cleanupBackupCompleted?.()
  cleanupRestoreStarted?.()
  cleanupRestoreCompleted?.()
  cleanupMenuCommand?.()
  cleanupQuitToast?.()
  cleanupSchedulerTaskStarted?.()
  cleanupGatewayRemoteTab?.()
  cleanupGatewayRemoteTask?.()
  cleanupImConnectionChange?.()
  cleanupImSendFailure?.()
  cleanupAiProfileFallback?.()
  cleanupRunTask?.()
  cleanupInstallSkill?.()
  cleanupWatchEnsureTab?.()
  cleanupWatchProactiveMessage?.()
  cleanupWatchActivateMessage?.()
  cleanupAgentRunning?.()
  cleanupAgentCompleteForProactive?.()
  cleanupAgentNeedConfirmGlobal?.()
  cleanupAgentConfirmResolvedGlobal?.()
  cleanupAgentErrorForTabAttention?.()
  cleanupFullScreenChange?.()
  if (recallSidebarAnimTimer) clearTimeout(recallSidebarAnimTimer)
  stopRecallSidebarResize()
  stopUpdaterPrompts()
})
</script>

<template>
  <div
    class="app-container"
    :class="{
      'sidebar-open': showSidebar,
      'is-mac': isMac,
      'is-win': isWin,
      'is-fullscreen': isFullScreen,
      'nav-collapsed': !showRecallSidebar,
      'main-leftmost': !showRecallSidebar && !showSidebar,
      'has-ai-toggle': showAiPanelToggle,
    }"
    :data-ui-theme="currentUiTheme"
    :data-color-scheme="currentColorScheme"
  >
    <!-- 主体内容：不再有全宽标题栏，侧栏与主区各有自己的顶条 -->
    <div class="app-body">
      <!-- 主导航侧栏：新对话 / 联络 / 终端 + 最近对话 + 秘书 -->
      <aside
        class="sidebar sidebar--recall sidebar--app"
        :class="{ 'is-collapsed': !showRecallSidebar, 'is-resizing': isRecallSidebarResizing, 'is-animating': isRecallSidebarAnimating }"
        :style="{ '--sidebar-panel-width': `${recallSidebarWidth}px`, width: showRecallSidebar ? `${recallSidebarWidth}px` : '0px' }"
        :inert="showRecallSidebar ? undefined : true"
      >
        <!-- 侧栏顶只负责对齐与拖窗口；前进后退浮在窗口上，视觉上钉在这一排右侧 -->
        <div class="shell-top shell-top--sidebar">
          <span class="shell-top-fill" />
        </div>
        <div class="sidebar-content sidebar-content--recall">
          <AppSidebar
            :awakened="isAwakened"
            @open-todos="terminalStore.openTodos()"
            @open-watch="openWatchesFromWelcome"
            @open-awaken="showWatchPanel = false; showAwaken = true"
            @open-connection="openConnectionSettings"
            @open-settings="openConnectionSettings"
            @logout="onSsoSoftLogout"
          />
        </div>
        <div
          class="recall-sidebar-resize-handle"
          :class="{ resizing: isRecallSidebarResizing }"
          @mousedown="startRecallSidebarResize"
        />
      </aside>

      <!-- 左侧边栏 - 主机管理（欢迎页上为叠加层） -->
      <aside
        class="sidebar sidebar--hosts"
        :class="{
          'sidebar--overlay': showRecallSidebar,
          'is-collapsed': !showSidebar,
          'is-resizing': isRecallSidebarResizing,
        }"
        :style="{ '--sidebar-panel-width': hostSidebarWidth, width: showSidebar ? hostSidebarWidth : '0px' }"
        :inert="showSidebar ? undefined : true"
      >
        <div class="sidebar-header">
          <span>{{ t('header.hostManager') }}</span>
          <button class="btn-icon btn-sm" @click="showSidebar = false" :title="t('header.closeSidebar')">
            <X :size="14" />
          </button>
        </div>
        <div class="sidebar-content">
          <SessionManager @open-sftp="openSftp" />
        </div>
      </aside>

      <!-- 终端区域 / 欢迎页 / 智能巡检 -->
      <main class="terminal-area">
        <!-- 主区顶条只在页面没有自己的第一排时出现（欢迎页 / 空终端 / 待办）。
             终端页 / 助手 / 巡检由各栏自己的顶栏顶到窗口上沿。 -->
        <div
          v-if="needsShellTop"
          class="shell-top shell-top--main"
        >
          <span class="shell-top-fill" />
        </div>

        <TerminalPlaceEmpty
          v-if="showTerminalEmpty"
          class="main-surface"
          @open-local="openLocalFromWelcome"
          @open-ssh="openSshFromWelcome"
          @manage-hosts="openHostSidebar"
        />
        <WelcomePage
          v-show="showWelcomePage"
          :active="showWelcomePage"
          :ready="welcomePageReady"
          class="main-surface"
          @open-assistant="openAssistantFromWelcome"
          @open-local="openLocalFromWelcome"
          @open-ssh="openSshFromWelcome"
          @open-session-manager="openSessionManagerFromWelcome"
          @open-smart-patrol="openSmartPatrolFromWelcome"
          @open-watches="openWatchesFromWelcome"
        />
        <SmartPatrolPage
          v-if="showSmartPatrol && !terminalStore.todosActive"
          class="main-surface"
          @back="backFromSmartPatrol"
        />
        <TodoPanel
          v-if="terminalStore.todosActive"
          class="main-surface"
          @close="closeTodosPanel"
        />
        <!-- 有 tab 即挂载工作台；外层原生 div + v-show 控制显隐（component 上 v-show 的 scoped 样式不可靠） -->
        <div
          v-for="tab in terminalStore.tabs"
          :key="tab.id"
          v-show="showTabWorkbench && tab.id === activeSurfaceTabId"
          class="tab-view main-surface"
        >
          <component
            :is="resolveWorkbenchRenderer(resolveWorkbenchKind(tab))"
            :ref="(el: unknown) => setTabViewRef(tab.id, el)"
            :tab="tab"
            :is-active="showTabWorkbench && tab.id === activeSurfaceTabId"
            :class="tab.type === 'assistant' ? 'tab-view-workbench' : 'tab-view-inner'"
            @open-ssh="openHostSidebar"
          />
        </div>
      </main>

      <!-- 窗口右上常驻：对话栏开关 + SSO + Windows 窗口按钮。
           钉在窗口坐标上，不跟对话栏开合跑（与左上侧栏开关同一套）。 -->
      <div class="main-float main-float--right">
        <button
          v-if="showAiPanelToggle"
          type="button"
          class="btn-icon ai-panel-toggle-btn"
          :class="{ 'is-collapsed': !aiPanelVisible }"
          :title="t('shell.toggleAiPanel')"
          :aria-expanded="aiPanelVisible"
          @click="toggleAiPanel"
        >
          <PanelRightClose v-if="aiPanelVisible" :size="14" :stroke-width="2" />
          <PanelRightOpen v-else :size="14" :stroke-width="2" />
        </button>
        <template v-if="authStore.showSoftEntry">
          <button
            v-if="!authStore.isAuthenticated"
            class="btn-icon btn-icon-header sso-soft-btn"
            :disabled="authStore.loading"
            :title="t('header.ssoLogin')"
            @click="onSsoSoftLogin"
          >
            {{ t('header.ssoLogin') }}
          </button>
          <button
            v-else-if="recallSidebarCollapsed"
            class="btn-icon btn-icon-header sso-soft-btn"
            :title="authStore.user?.email || authStore.user?.name || t('header.ssoLogout')"
            @click="onSsoSoftLogout"
          >
            {{ t('header.ssoLogout') }}
          </button>
        </template>
        <!-- Windows 自绘标题栏按钮（最小化 / 最大化 / 关闭）：仅 Win 平台 + 非全屏时显示。
             全屏模态打开时，模态全屏覆盖会自动遮住这三个按钮，模态自带的 X 是唯一可见关闭入口。 -->
        <WindowControls v-if="isWin && !isFullScreen" />
      </div>

      <!-- 窗口左上常驻：侧栏开关。钉在窗口坐标上，不跟侧栏开合跑。
           主机管理盖在这排上面时 inert，避免还能 Tab 到被盖住的按钮。 -->
      <div
        class="shell-chrome"
        :class="{ 'shell-chrome--traffic-inset': isMac && !isFullScreen }"
        :inert="showSidebar ? true : undefined"
      >
        <button
          v-if="isWin"
          ref="appMenuBtnRef"
          class="btn-icon btn-icon-header app-menu-btn"
          @click="openAppMenuFromButton"
          :title="t('header.appMenu')"
        >
          <MenuIcon :size="18" />
        </button>
        <button
          class="btn-icon sidebar-toggle-btn"
          :class="{ 'is-collapsed': !showRecallSidebar, 'has-attention': sidebarToggleAttention }"
          :title="showRecallSidebar ? t('shell.toggleSidebar') : t('shell.expandSidebar')"
          :aria-expanded="showRecallSidebar"
          @click="toggleRecallSidebarCollapsed"
        >
          <PanelLeftClose v-if="showRecallSidebar" :size="14" :stroke-width="2" />
          <PanelLeftOpen v-else :size="14" :stroke-width="2" />
        </button>
      </div>
      <div
        class="shell-nav-chrome"
        :class="{
          'is-resizing': isRecallSidebarResizing,
          'is-animating': isRecallSidebarAnimating,
        }"
        :style="{ width: showRecallSidebar ? `${recallSidebarWidth}px` : '0px' }"
        :inert="showSidebar ? true : undefined"
      >
        <div class="shell-nav-chrome-inner" :style="{ width: `${recallSidebarWidth}px` }">
          <button
            type="button"
            class="btn-icon shell-nav-btn"
            :disabled="!canGoBack"
            :title="navBackShortcut ? `${t('shell.navBack')} (${navBackShortcut})` : t('shell.navBack')"
            @click="goBack"
          >
            <ChevronLeft :size="14" :stroke-width="2" />
          </button>
          <button
            type="button"
            class="btn-icon shell-nav-btn"
            :disabled="!canGoForward"
            :title="navForwardShortcut ? `${t('shell.navForward')} (${navForwardShortcut})` : t('shell.navForward')"
            @click="goForward"
          >
            <ChevronRight :size="14" :stroke-width="2" />
          </button>
        </div>
      </div>
    </div>

    <!-- 启动 / 知识库 / 备份：共用一条底部状态栏（fixed overlay，不占 flex） -->
    <Transition name="slide-down">
      <div v-if="bottomStatusVisible" class="bottom-status-bar">
        <div class="upgrade-content">
          <Loader2 class="upgrade-icon" :size="16" />
          <span class="upgrade-text">
            {{ bottomStatusText }}
            <template v-if="bottomStatusShowingKnowledge && knowledgeLoadingProgress.total > 0">
              ({{ knowledgeLoadingProgress.current }}/{{ knowledgeLoadingProgress.total }}<template v-if="knowledgeLoadingProgress.libraryTotal > knowledgeLoadingProgress.total">，文库共 {{ knowledgeLoadingProgress.libraryTotal }} 篇</template>)
            </template>
          </span>
          <span
            v-if="bottomStatusShowingKnowledge && knowledgeLoadingProgress.filename"
            class="upgrade-filename"
          >
            {{ knowledgeLoadingProgress.filename }}
          </span>
        </div>
        <div class="upgrade-progress">
          <div
            v-if="bottomStatusHasPercent"
            class="upgrade-progress-bar"
            :style="{ width: bottomStatusPercent + '%' }"
          />
          <div v-else class="startup-progress-indeterminate" />
        </div>
      </div>
    </Transition>

    <!-- 控制面板 -->
    <SettingsModal 
      v-if="showSettings" 
      :initial-tab="settingsInitialTab"
      :initial-section="settingsInitialSection"
      :pending-install-skill-id="pendingInstallSkillId"
      @close="closeSettings"
      @restart-setup="restartSetup"
    />

    <!-- SFTP 文件管理器弹窗 -->
    <FileExplorer
      v-if="showFileExplorer && sftpConfig"
      :config="sftpConfig"
      @close="closeSftp"
    />

    <!-- 首次启动引导向导 -->
    <SetupWizard
      v-if="showSetupWizard"
      @complete="onSetupComplete"
    />

    <!-- SSO hard 门控（features.sso + gateMode=hard 且未登录） -->
    <SsoLoginGate v-if="authStore.blockApp" />

    <!-- 觉醒面板（Steam 或 OEM 关闭时不渲染） -->
    <Awaken
      v-if="showAwaken && canShowAwaken"
      @close="onAwakenClose"
      @awakened-change="isAwakened = $event"
    />

    <!-- 关切面板（独立入口，与觉醒分离） -->
    <WatchPanel
      v-if="showWatchPanel && canShowWatch"
      :initial-tab="watchPanelInitialTab"
      @close="onWatchPanelClose"
    />

    <!-- 全局 Toast 提示 -->
    <Toast />
    <!-- 更新提示：右下角非打断角标卡 -->
    <UpdateNotifyCard />

    <!-- macOS ⌘Q 防误触提示 -->
    <Transition name="quit-toast">
      <div v-if="quitToastVisible" class="quit-toast-overlay">
        <span class="quit-toast-key">⌘Q</span>
        <span class="quit-toast-text">{{ $t('quitToastHint') }}</span>
        <div class="quit-toast-progress" />
      </div>
    </Transition>

    <!-- 全局确认对话框 -->
    <ConfirmDialog
      :show="showConfirmDialog"
      :options="confirmOptions"
      @confirm="handleConfirm"
      @cancel="handleCancel"
      @neutral="handleNeutral"
      @close="handleClose"
    />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--bg-primary);
  /* 主区第一排要给浮在其上的窗口控件让出的宽度（见 main.css「第一排契约」） */
  --shell-inset-left: 0px;
  --shell-inset-right: 0px;
  /* 挂在窗口根上，欢迎页顶条和全屏面板（关切 / 觉醒 / 控制面板）共用，红绿灯按这个高度居中 */
  --workbench-panel-header-height: 38px;
}

/* 侧栏收起且主区贴着窗口左沿：第一排让出左上那排常驻控件
   8 + 26 + 8 = 42（只剩开关；后退/前进已跟侧栏走） */
.app-container.nav-collapsed.main-leftmost {
  --shell-inset-left: 42px;
}

/* Windows 还多一个汉堡菜单：22px + 4px gap */
.app-container.is-win.nav-collapsed.main-leftmost {
  --shell-inset-left: 68px;
}

/* macOS 主区自己贴着窗口左沿时，还要再让开红绿灯 */
.app-container.is-mac.nav-collapsed.main-leftmost:not(.is-fullscreen) {
  --shell-inset-left: calc(var(--mac-traffic-light-inset) + 34px);
}

/* Windows 自绘三按钮（46px × 3）浮在主区右上 */
.app-container.is-win:not(.is-fullscreen) {
  --shell-inset-right: 138px;
}

/* 左上控件、侧栏顶、主区透明拖拽条与对话顶栏同一行高。
   欢迎页 / 空终端 / 待办没有自己的第一排，必须靠这条透明区拖窗口；
   漏掉它时高度会塌成 0，主区既拖不动也会整页顶上去。
   收起侧栏时折叠按钮会跟「严格/宽松/自由」并排，行高不齐就会看出
   红绿灯和折叠按钮不在垂直居中。macOS 红绿灯也按这个高度居中
   （见 electron/main.ts trafficLightPosition）。 */
.app-container .shell-chrome,
.app-container .shell-nav-chrome,
.app-container .shell-top--sidebar,
.app-container .shell-top--main,
.app-container .sidebar-header {
  height: var(--workbench-panel-header-height);
}

/* 与对话/产出物顶栏同一盒模型：38px 里含 1px 底边，22px 按钮才会落在同一条中线上 */
.app-container .shell-chrome,
.app-container .shell-nav-chrome,
.app-container .main-float {
  box-sizing: border-box;
  border-bottom: 1px solid transparent;
}

/* 非 Windows：SSO 软登录也浮在主区右上，第一排（含产出物展开按钮）要让开 */
.app-container:not(.is-win):has(.sso-soft-btn) {
  --shell-inset-right: 148px;
}

/* 浮层本身不吃鼠标，空白处的拖拽仍由下面的第一排接住；只有按钮接收点击。
   钉在 .app-body（窗口坐标）上，z-index 与左上侧栏开关同档，避免被工作台挡住。 */
.main-float {
  position: absolute;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 4px;
  height: var(--workbench-panel-header-height);
  padding: 0 8px;
  pointer-events: none;
}

.main-float > * {
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

/* 窗口左上常驻控件：位置按窗口坐标，不跟侧栏宽度走 */
.shell-chrome {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 4px;
  height: var(--shell-top-height);
  padding: 0 8px;
  pointer-events: none;
}

.shell-chrome > * {
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

.shell-chrome--traffic-inset {
  padding-left: var(--mac-traffic-light-inset);
}

/* 前进后退：浮在窗口上，不进侧栏拖窗口层。外层跟侧栏同宽被裁，内层定住，开合时按钮不跟着跑。 */
.shell-nav-chrome {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 41;
  height: var(--shell-top-height);
  overflow: hidden;
  pointer-events: none;
  transition: width var(--shell-drawer-duration) var(--shell-drawer-ease);
}

.shell-nav-chrome-inner {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: 100%;
  padding: 0 8px;
  box-sizing: border-box;
}

.shell-nav-chrome-inner > * {
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

.shell-nav-chrome.is-resizing {
  transition: none;
}

.shell-nav-chrome.is-animating {
  will-change: width;
  contain: paint;
}

.main-float--right {
  right: 0;
  padding-right: 8px;
  gap: 8px;
}

/* Windows 三按钮必须贴窗口右沿；开关在它们左边，靠 gap 留空 */
.app-container.is-win:not(.is-fullscreen) .main-float {
  border-bottom: none;
}

.app-container.is-win:not(.is-fullscreen) .main-float--right {
  padding-right: 0;
}

/* 侧栏顶 / 主区顶：两段各自的顶条，共用高度与拖拽行为，保证窗口上沿基线齐平 */
.shell-top {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
  height: var(--shell-top-height);
  padding: 0 8px;
  -webkit-app-region: drag;
}

/* 带底部分隔线的顶条要多留那 1px：边框吃进高度的话，这排图标的中心会比红绿灯
   高半像素——红绿灯是系统按窗口坐标画的，不认我们的边框。
   只能加在高度上，盒模型必须保持 border-box：侧栏给直接子元素定了展开宽度，
   换成 content-box 会让左侧让位的 68px 顶出侧栏、右端按钮被裁掉。 */
.shell-top--sidebar,
.shell-top--main.shell-top--tabs {
  height: calc(var(--shell-top-height) + 1px);
}

.shell-top > * {
  -webkit-app-region: no-drag;
}

/* 撑开的空白仍要能拖窗口 */
.shell-top-fill {
  flex: 1;
  min-width: 0;
  align-self: stretch;
  -webkit-app-region: drag;
}

.shell-top--sidebar {
  border-bottom: 1px solid transparent;
}

/* 主区顶默认是透明的一条：视觉上主区没有标题栏，但这块地方必须留着，
   否则无边框窗口没有拖拽区（拖不动窗口），Windows 三按钮也无处安放 */
.shell-top--main {
  background: transparent;
}

/* 只有装着终端 Tab 条时才现出底板与分隔线 */
.shell-top--main.shell-top--tabs {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

/* 壳层顶条同样是第一排，按 inset 给浮层让位。
   让位宽度随侧栏开合改变，跟着侧栏用同一档节奏挪，才不会一边在滑一边在跳 */
.shell-top--main {
  padding-left: max(8px, var(--shell-inset-left));
  padding-right: max(8px, var(--shell-inset-right));
  transition: padding var(--shell-drawer-duration) var(--shell-drawer-ease);
}

/* 侧栏顶给左上开关让位，拖拽区从按钮右侧开始；后退/前进在本排右侧 */
.app-container .shell-top--sidebar {
  padding-left: 42px;
}

.app-container.is-win .shell-top--sidebar {
  padding-left: 68px;
}

.app-container.is-mac .shell-top--sidebar {
  padding-left: calc(var(--mac-traffic-light-inset) + 34px);
}

.app-container.is-mac.is-fullscreen .shell-top--sidebar {
  padding-left: 42px;
}

/* 深色主题：Tab 条形态保持与原顶栏同一质感 */
[data-color-scheme="dark"] .shell-top--main.shell-top--tabs {
  background: linear-gradient(180deg, var(--bg-secondary) 0%, rgba(var(--bg-secondary-rgb, 24, 24, 37), 0.95) 100%);
}

[data-color-scheme="light"] .shell-top--main.shell-top--tabs {
  background: var(--bg-secondary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

/* header 按钮尺寸与 hover scale 统一由 main.css 的 .btn-icon-header 变体提供 */

/* 侧栏开关：紧邻红绿灯，做成"轻触感"而非工具栏图标——
   静默时只是一枚淡淡的线条图标（不抢红绿灯的注意力），hover 才浮出底板。
   图标随开合换向（收起时朝外推、展开时朝内收），点之前就知道会发生什么。 */
.sidebar-toggle-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 5px;
  line-height: 0;
  color: var(--text-tertiary, var(--text-secondary));
  background: transparent;
  transition: background 0.18s ease, color 0.18s ease;
}

.sidebar-toggle-btn svg {
  display: block;
}

/* 与红绿灯之间留出一档呼吸，避免圆形彩色按钮紧挨着方形线框图标 */
.app-container.is-mac .shell-chrome .sidebar-toggle-btn {
  margin-left: 2px;
}

.shell-nav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 5px;
  line-height: 0;
  color: var(--text-tertiary, var(--text-secondary));
  background: transparent;
  transition: background 0.18s ease, color 0.18s ease, opacity 0.18s ease;
}

.shell-nav-btn svg {
  display: block;
}

.shell-nav-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover, rgba(127, 127, 127, 0.14));
  transform: none;
}

.btn-icon.shell-nav-btn:disabled:hover,
.btn-icon.shell-nav-btn:disabled:hover svg {
  background: transparent;
  transform: none;
  filter: none;
}

.shell-nav-btn:hover:not(:disabled) svg {
  filter: none;
}

.shell-nav-btn:active:not(:disabled) {
  background: var(--bg-active, rgba(127, 127, 127, 0.2));
}

.shell-nav-btn:disabled {
  opacity: 0.32;
  cursor: default;
}

.sidebar-toggle-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover, rgba(127, 127, 127, 0.14));
  /* 顶栏高度有限，这里不做放大，避免顶到 header 边界 */
  transform: none;
}

.sidebar-toggle-btn:active {
  background: var(--bg-active, rgba(127, 127, 127, 0.2));
}

/* 收起态：侧栏不在眼前，图标稍微提一点存在感，提示"这里还能展开" */
.sidebar-toggle-btn.is-collapsed {
  color: var(--text-secondary);
}

/* 对话栏开关：与左边那枚侧栏开关同一套轻触感，方向相反，钉在窗口右上 */
.ai-panel-toggle-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  /* 与产出物顶栏「打开 / 发送到手机」同一尺寸，并排才齐 */
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 5px;
  line-height: 0;
  color: var(--text-tertiary, var(--text-secondary));
  background: transparent;
  transition: background 0.18s ease, color 0.18s ease;
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

.ai-panel-toggle-btn svg {
  display: block;
}

.ai-panel-toggle-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover, rgba(127, 127, 127, 0.14));
  transform: none;
}

.ai-panel-toggle-btn:hover svg {
  filter: none;
}

.ai-panel-toggle-btn:active {
  background: var(--bg-active, rgba(127, 127, 127, 0.2));
}

.ai-panel-toggle-btn.is-collapsed {
  color: var(--text-secondary);
}

/* header 图标不发光（与 btn-icon-header 同一取向），避免顶栏出现彩色光晕 */
.sidebar-toggle-btn:hover svg {
  filter: none;
}

/* 收起时侧栏里的动静打到这枚按钮上。描边取 header 底色，
   让圆点浮在图标之上而不是和线条糊成一团。 */
.sidebar-toggle-btn.has-attention::after {
  content: '';
  position: absolute;
  top: 3px;
  right: 3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent, #7aa2f7);
  box-shadow: 0 0 0 2px var(--bg-secondary);
}

.sso-soft-btn {
  max-width: 140px;
  padding: 0 10px !important;
  width: auto !important;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-icon.awakened-active {
  color: var(--brand-vital);
}

/* 主体 */
.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
  position: relative;
  /* 最近对话侧栏 panel-header 与 AiPanel system-info-bar 共用，保证顶栏底边对齐 */
  /* 壳层顶条高度跟对话顶栏走，避免再单独维护一份数字 */
  --shell-top-height: var(--workbench-panel-header-height);
}

/* 侧边栏 */
.sidebar {
  width: var(--sidebar-width);
  min-width: 0;
  flex: 0 0 auto;
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  position: relative;
}

/* 侧栏的开合是「抽屉推拉」：收起时宽度归零、内容被裁掉，而不是整块凭空消失。
   为此收起后元素仍留在 DOM 里（display:none 没法过渡），靠 inert 挡住键盘焦点。 */
.sidebar {
  overflow: hidden;
  transition: width var(--shell-drawer-duration) var(--shell-drawer-ease);
}

/* 内容按展开宽度定住，宽度收缩时才是被裁走，而不是跟着挤成一团。
   拖宽手柄自己贴着右边缘，不参与这个定宽。 */
.sidebar > :not(.recall-sidebar-resize-handle) {
  width: var(--sidebar-panel-width, var(--sidebar-width));
}

.sidebar.is-collapsed {
  border-right-color: transparent;
}

/* 拖宽时宽度每帧都在变，过渡会让它跟不上手 */
.sidebar.is-resizing {
  transition: none;
}

.sidebar.is-animating {
  will-change: width;
}

/* 侧边栏右边缘光效 */
.sidebar::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.15), transparent);
  pointer-events: none;
}

/* 主机管理侧栏的头现在也顶到窗口上沿：与两条顶条同高、同样能拖窗口 */
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  /* 同 .shell-top：多留 1px 给底部分隔线，否则内容中心与红绿灯差半像素 */
  height: calc(var(--shell-top-height) + 1px);
  padding: 0 12px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  -webkit-app-region: drag;
}

.sidebar-header > * {
  -webkit-app-region: no-drag;
}

/* 主机管理侧栏总在最左（叠加态也是），macOS 下同样要给红绿灯让位。
   让位量比标准值再多一档：这排放的是加粗大写标题，紧挨着红绿灯会像贴在上面，
   而标准让位量只按图标控件留了呼吸 */
.app-container.is-mac .sidebar-header {
  padding-left: calc(var(--mac-traffic-light-inset) + 42px);
}

.app-container.is-mac.is-fullscreen .sidebar-header {
  padding-left: 48px;
}

.app-container.is-win .sidebar-header {
  padding-left: 68px;
}

.sidebar-header .btn-icon {
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

/* 欢迎页「最近对话」侧栏：比主机管理更退后，避免抢主区视觉焦点 */
.sidebar--recall {
  flex-shrink: 0;
  background: var(--bg-secondary);
}

.recall-sidebar-resize-handle {
  position: absolute;
  top: var(--workbench-panel-header-height);
  right: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.25s ease;
  z-index: 5;
}

.recall-sidebar-resize-handle::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 40px;
  background: var(--border-color);
  border-radius: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.recall-sidebar-resize-handle:hover::after,
.recall-sidebar-resize-handle.resizing::after {
  opacity: 1;
}

.recall-sidebar-resize-handle:hover,
.recall-sidebar-resize-handle.resizing {
  background: linear-gradient(180deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.3), transparent);
}

.recall-sidebar-resize-handle.resizing::after {
  background: var(--accent-primary);
  box-shadow: 0 0 10px var(--accent-primary);
}

.sidebar--recall::after {
  display: none;
}

.sidebar-content--recall {
  overflow-y: hidden;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  contain: paint;
}

/* 欢迎页：主机管理叠加在最近对话侧栏之上，关掉后最近对话仍可见。
   必须盖过窗口左上的侧栏开关 / 前进后退（z-index 40/41），否则会挡住关闭按钮。 */
.sidebar--hosts:not(.is-collapsed) {
  z-index: 50;
}

.sidebar--overlay {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 50;
  box-shadow: 6px 0 28px rgba(0, 0, 0, 0.28);
}

/* 终端区域 */
.terminal-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

/* 欢迎页 / 巡检 / tab 工作台共用：隐藏时不占 flex 空间 */
.main-surface {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 每个 Tab 的独立容器 */
.tab-view {
  overflow: hidden;
}

.tab-view-inner {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* 助手工作台：仅撑满容器，水平/垂直分割由 WorkbenchShell 自行控制 */
.tab-view-workbench {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* 启动 / 知识库 / 备份共用底部状态栏：fixed overlay，不参与 flex 布局 */
.bottom-status-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  z-index: 1000;
}

.startup-progress-indeterminate {
  height: 2px;
  background: var(--accent-primary);
  width: 40%;
  animation: indeterminate-scan 1.4s cubic-bezier(0.65, 0.815, 0.735, 0.395) infinite;
}

@keyframes indeterminate-scan {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
}

.upgrade-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.upgrade-icon {
  animation: spin 1s linear infinite;
  color: var(--accent-primary);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.upgrade-text {
  color: var(--text-primary);
}

.upgrade-filename {
  color: var(--text-tertiary);
  font-size: 12px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upgrade-progress {
  height: 2px;
  background: var(--bg-tertiary);
}

.upgrade-progress-bar {
  height: 100%;
  background: var(--accent-primary);
  transition: width 0.3s ease;
}

/* 进度条动画 */
.slide-down-enter-active,
.slide-down-leave-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

/* ⌘Q 防误触提示条 */
.quit-toast-overlay {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10002;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  pointer-events: none;
  overflow: hidden;
}

.quit-toast-key {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.quit-toast-text {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
}

.quit-toast-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  width: 100%;
  background: var(--accent-primary, #5b8af5);
  transform-origin: left center;
  animation: quit-toast-countdown 2s linear forwards;
}

@keyframes quit-toast-countdown {
  from { transform: scaleX(1); }
  to   { transform: scaleX(0); }
}

.quit-toast-enter-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.quit-toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.quit-toast-enter-from,
.quit-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
}

</style>

