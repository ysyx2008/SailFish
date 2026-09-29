import { defineStore } from 'pinia'
import { ref, computed, watch, toRaw } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import stripAnsiLib from 'strip-ansi'
import i18n from '../i18n'
import type { JumpHostConfig } from './config'
import { useConfigStore } from './config'
import type { TerminalScreenService, ScreenContent } from '../services/terminal-screen.service'
import type { TerminalSnapshotManager, TerminalSnapshot, TerminalDiff } from '../services/terminal-snapshot.service'
import { useAssistantArtifactStore } from '@sailfish/workbench-assistant/artifact/store'
import { createLogger } from '../utils/logger'
import { formatSshConnectFailure } from '../utils/ssh-connect-error'
import {
  findActivePaneInLayout,
  findPaneById,
  getAllTerminalPanes,
  removePaneFromLayout,
  movePaneToEdge as movePaneToEdgeInTree,
  splitLeafAtEdge,
  type PaneEdge,
} from './split-pane-tree'

export type { PaneEdge }

export type LayoutDrag =
  | { kind: 'pane'; tabId: string; paneId: string }
  | { kind: 'ssh-session'; sessionId: string }
  | { kind: 'new-local' }

export type SshSplitAtEdgeRequest = {
  sessionId: string
  tabId: string
  paneId: string
  edge: PaneEdge
}
import { WELCOME_COMPOSER_TAB_ID } from '../constants/welcome-composer'
import { showConfirm } from '../composables/useConfirm'
import type { PendingImage } from '../composables/useImageUpload'
import {
  CLOSED_HISTORY_CONVERSATION_META,
  deriveTabAgentUiMeta,
  hasHubTasksAreaAttention,
  toHistoryConversationMeta,
  type ConversationSurfaceState,
  type HistoryConversationMeta,
  type HistoryConversationTabStatus,
  type TabAgentUiMeta,
} from '../utils/agent-tab-ui-meta'

const log = createLogger('Store')

/** 欢迎页 composer 发送到助手 tab 时的 handoff 载荷 */
export interface PendingComposerHandoff {
  message: string
  images: PendingImage[]
  skillIds?: string[]
}

export type ShellType = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh' | 'unknown'
export type OSType = 'windows' | 'linux' | 'macos' | 'unknown'

export interface SystemInfo {
  os: OSType
  shell: ShellType
  shellPath?: string
  description: string
}

export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

// Agent 共享类型（从 @shared/types 统一导入）
export type {
  TerminalType,
  RiskLevel,
  StepProgress,
  AgentPlanStep,
  AgentPlan,
  AgentStep,
  PendingConfirmation,
} from '@shared/types'

import type { TerminalType, AgentStep, AgentContextBar, PendingConfirmation, RemoteChannel, AttachmentInfo, AgentRecord } from '@shared/types'
import { COMPANION_AGENT_KEY, deriveContextBarFromSteps } from '@shared/types'
import { isWorkbenchAvailable } from '../workbench/registry'

export type {
  TabAgentUiStatus,
  TabAgentUiMeta,
  HistoryConversationTabStatus,
  HistoryConversationMeta,
  ConversationSurfaceState,
} from '../utils/agent-tab-ui-meta'

export interface AgentState {
  isRunning: boolean
  agentId?: string
  sessionId?: string     // 会话 ID（用于会话级保存，后端通过此 ID 从 HistoryService 加载历史数据）
  sessionStartTime?: number  // 会话开始时间
  userTask?: string      // 首条 user_task / 历史 record.userTask（侧栏无 title 时的回退）
  /** 侧栏展示标题（LLM 生成或用户重命名）；缺省时 UI 回退 userTask */
  title?: string
  steps: AgentStep[]
  /**
   * 会话级上下文栏快照（后端 onContextBar 推送）。
   * 状态栏优先读此字段；历史加载时可由 steps 派生。
   */
  contextBar?: AgentContextBar
  pendingConfirm?: PendingConfirmation
  pendingSecureInput?: import('@shared/types').PendingSecureInput & { ptyId?: string }
  /** 后台 tab：Agent 已结束（成功或报错）而用户当时不在该 tab，用于标签栏高亮引导 */
  agentCompletedUnseen?: boolean
  finalResult?: string   // Agent 完成后的最终回复
  /**
   * 标记：当前 agentState 来自加载历史，且后端 Agent 实例尚未通过新任务把会话状态加载到 in-memory。
   * fork 会 fallback 到 HistoryService（sourceSessionId）；用户发起首次新任务后清除
   * （initializeRun 触发 restoreFromHistory，in-memory 状态就齐了）。
   */
  loadedFromHistory?: boolean
}

// 上传的文档类型（与 electron/services/document-parser.service.ts 同步）
export interface ParsedDocument {
  filename: string
  filePath?: string
  fileType: string
  content: string
  fileSize: number
  parseTime: number
  pageCount?: number
  totalPages?: number
  images?: string[]
  metadata?: Record<string, string>
  error?: string
}

export interface TerminalTab {
  id: string
  title: string
  // 用户自定义的标签名称，设置后优先显示，清空则恢复自动标题
  customTitle?: string
  type: TerminalType
  ptyId?: string
  sshConfig?: {
    host: string
    port: number
    username: string
  }
  // SSH 会话 ID（用于重连时从 configStore 获取完整配置）
  sshSessionId?: string
  systemInfo?: SystemInfo
  isConnected: boolean
  isLoading: boolean
  // 加载提示信息（用于显示具体的加载原因）
  loadingMessage?: string
  /** 正在进行的 SSH 连接尝试标识：连接未完成时用它中止握手（连接完成后清空） */
  connectAttemptId?: string
  // 连接错误信息（用于显示连接失败的具体原因）
  connectionError?: string
  // 终端输出缓冲（最近的输出）
  outputBuffer?: string[]
  // 最近检测到的错误
  lastError?: {
    content: string
    timestamp: Date
  }
  // 当前选中的文本
  selectedText?: string
  // AI 对话历史（每个终端独立）
  aiMessages?: AiMessage[]
  // AI 是否正在生成回复
  aiLoading?: boolean
  // AI 对话滚动位置状态（用户是否在底部附近）
  aiScrollNearBottom?: boolean
  // AI 对话滚动位置（用于切换 tab 时恢复）
  aiScrollTop?: number
  /** 滚动比例 0–1（scrollTop / maxScroll），虚拟列表重测高度后比绝对像素更稳 */
  aiScrollRatio?: number
  /**
   * 锚定复原：保存时记"视口顶部那条 item 的 id + 距视口顶的 offset"，
   * 切回用 scrollToIndex(id→index, {align:'start', offset}) 精确复原，
   * 不受虚拟列表估算→实测高度修正导致的 maxScroll 漂移影响。
   */
  aiScrollAnchor?: { id: string; offset: number }
  // Agent 状态（每个终端独立）
  agentState?: AgentState
  // 上传的文档（每个终端独立）
  uploadedDocs?: ParsedDocument[]
  // 是否为远程 Gateway Agent 标签页
  isRemote?: boolean
  // 远程 IM 通道类型（仅远程 Agent 标签页使用，决定可用的 IM 工具集）
  remoteChannel?: RemoteChannel
  // 独立助手 Agent ID（仅 assistant 类型标签页使用）
  agentId?: string
  /**
   * 工作台 kind（可选）。有值时优先于 `type` / companion 映射，
   * 用于 OEM/业务岗（如 `sample`、自建 kind）。见 `resolveWorkbenchKind`。
   */
  workbenchKind?: string
  /**
   * 本地助手会话是否已「提升」为独立 tab（显示在 Tab 栏、豁免 LRU 回收）。
   * 未提升的本地助手会话仅在 Hub 主区（首页视图）按焦点显示，不出现在 Tab 栏。
   */
  isPromoted?: boolean
  /** 最近一次成为 Hub 焦点的时间戳（ms），用于 LRU 淘汰排序 */
  lastFocusedAt?: number
  // 分屏布局（分屏模式时使用）
  splitLayout?: SplitPane
}

/**
 * 分屏新窗格的目标连接源。
 *
 * - `inherit`：复用当前激活窗格的连接（默认；激活窗格是 SSH 就开同一会话的新连接，
 *   是本地就开新本地 shell）
 * - `local`：强制新开本地 shell（不论当前激活窗格是什么）
 * - `ssh`：连接到指定的已配置 SSH 会话（sessionId 取自 configStore.sshSessions）
 */
export type SplitTarget =
  | { kind: 'inherit' }
  | { kind: 'local' }
  | { kind: 'ssh', sessionId: string }

/** 批量命令可选目标（窗格粒度，非 Tab 粒度） */
export interface BatchCommandTarget {
  /** `${tabId}:${ptyId}` */
  key: string
  tabId: string
  ptyId: string
  terminalType: 'local' | 'ssh'
  tabTitle: string
  paneLabel?: string
  hostHint?: string
  isConnected: boolean
}

export type BatchCommandScope = 'tab' | 'all'

export interface SplitPane {
  id: string
  type: 'terminal' | 'split'
  direction?: 'horizontal' | 'vertical'
  children?: SplitPane[]
  // 终端窗格属性（type='terminal' 时使用）
  ptyId?: string        // 终端实例 ID
  terminalType?: 'local' | 'ssh'  // 终端类型
  sshConfig?: {         // SSH 配置（仅 SSH 类型）
    host: string
    port: number
    username: string
  }
  sshSessionId?: string // SSH 会话 ID
  label?: string        // 窗格标签（如 "左侧"、"右上"）
  isActive?: boolean    // 是否为当前焦点窗格
  // 布局属性
  size?: number         // 窗格大小（百分比，0-100）
  /** 这一扇还在握手（新开或重试），先出窗格、不挂终端画面 */
  isConnecting?: boolean
  /** 这一扇自己的连接失败原因（不要拿整页 loading 盖住旁边已连上的窗格） */
  connectionError?: string
  /** 正在进行的 SSH 握手，关这一扇时用来当场掐断 */
  connectAttemptId?: string
}

/**
 * Agent 终端上下文（用于发送给后端 Agent）
 *
 * 使用 discriminated union 强制调用方按 mode 分支处理：
 * - mode='single' 时可访问 ptyId、terminalOutput
 * - mode='split' 时可访问 panes、activePaneId
 *
 * 这样可以在 TS 编译期阻止"分屏模式下错误读 ptyId"这类静默 bug
 */
export interface AgentTerminalContextSingle {
  mode: 'single'
  ptyId: string
  terminalOutput: string[]
  systemInfo: { os: string; shell: string }
  terminalType: TerminalType
}

export interface AgentTerminalContextSplit {
  mode: 'split'
  // 兼容字段：取自激活窗格，后端 agent.ts 仍按单值消费这些字段
  ptyId: string
  terminalOutput: string[]
  terminalType: TerminalType
  systemInfo: { os: string; shell: string }
  // 多屏专属
  activePaneId: string | undefined
  panes: Array<{
    paneId: string
    ptyId: string
    label: string
    /** 此刻连着谁（会话名 / 登录账号与地址 / 本地终端），与界面窗格标签同源 */
    connectionName: string
    isActive: boolean
    terminalOutput: string[]
    terminalType: 'local' | 'ssh'
  }>
}

export type AgentTerminalContext = AgentTerminalContextSingle | AgentTerminalContextSplit

/** 本机 / SSH 工作台（壳上「终端」地方里的 tab） */
export function isLocalOrSshTab(tab: { type: string }): boolean {
  return tab.type === 'local' || tab.type === 'ssh'
}

/** Tab 栏可见 tab：终端、已提升本地助手、远程助手，但不含联络常驻 tab（与 TabBar.displayedTabs 一致） */
function isDisplayedInTabBar(tab: TerminalTab): boolean {
  if (tab.agentId === COMPANION_TAB_AGENT_ID) return false
  return !(tab.type === 'assistant' && !tab.isRemote && !tab.isPromoted)
}

/**
 * 关闭 tab 后选择下一个激活 tab：优先右侧相邻，否则左侧（浏览器 / Chrome 标准行为）。
 * `closedIndex` 为 splice 前的索引；调用时 tab 已从数组移除。
 */
function findAdjacentMatching(
  closedIndex: number,
  tabList: TerminalTab[],
  match: (t: TerminalTab) => boolean
): TerminalTab | undefined {
  for (let i = closedIndex; i < tabList.length; i++) {
    if (match(tabList[i])) return tabList[i]
  }
  for (let i = closedIndex - 1; i >= 0; i--) {
    if (match(tabList[i])) return tabList[i]
  }
  return undefined
}

function findAdjacentDisplayedTab(closedIndex: number, tabList: TerminalTab[]): TerminalTab | undefined {
  return findAdjacentMatching(closedIndex, tabList, isDisplayedInTabBar)
}

/** 联络常驻 tab 的 agentId，等同后端 `__companion__`（单一来源：@shared/types） */
export const COMPANION_TAB_AGENT_ID = COMPANION_AGENT_KEY

export const useTerminalStore = defineStore('terminal', () => {
  // 状态
  const tabs = ref<TerminalTab[]>([])
  const activeTabId = ref<string>('')
  /**
   * TabBar 固定面：「待办」伪 Tab（非 Agent 会话）。
   * 与 activeTabId / Hub 焦点互斥——打开待办时清空二者。
   */
  const todosActive = ref(false)
  // 激活真实 tab 时自动退出待办面（覆盖 createTab 等未走 setActiveTab 的路径）
  watch(activeTabId, (id) => {
    if (id) todosActive.value = false
  })
  /**
   * Hub（首页视图）主区当前聚焦的本地助手会话 tab。
   * 仅在任务区（activeTabId 为空且非待办面）时主区渲染该会话；为空 → 显示欢迎页。
   * 切到联络 / 待办时**保留**此 id，切回任务区可恢复；goToHome / clearHubFocus 才清空。
   * 已提升为独立 tab（isPromoted）或远程助手不走此焦点。
   */
  const hubFocusedAssistantTabId = ref<string>('')
  /** 上次激活的本机 / SSH tab，点侧栏「终端」时回到这里 */
  const lastTerminalTabId = ref('')
  /**
   * 人在「终端」这个地方但没有本机 / SSH tab：点侧栏「终端」进来，
   * 或关掉了最后一个终端 tab（仍留在终端，只是空了）。
   */
  const terminalPlaceActive = ref(false)

  /** 正在拖去排放 / 新建的东西；窗格四边落点只认这个 */
  const layoutDrag = ref<LayoutDrag | null>(null)
  /** 主机拖到边上：交给主机列表走原来的连上 / 问凭证 */
  const sshSplitAtEdgeRequest = ref<SshSplitAtEdgeRequest | null>(null)

  function beginLayoutDrag(drag: LayoutDrag): void {
    layoutDrag.value = drag
  }

  function endLayoutDrag(): void {
    layoutDrag.value = null
  }

  function requestSshSplitAtEdge(request: SshSplitAtEdgeRequest): void {
    sshSplitAtEdgeRequest.value = request
  }

  function consumeSshSplitAtEdgeRequest(): SshSplitAtEdgeRequest | null {
    const request = sshSplitAtEdgeRequest.value
    sshSplitAtEdgeRequest.value = null
    return request
  }

  // 终端计数器（用于生成唯一标题）
  const localTerminalCounter = ref(0)
  const sshTerminalCounters = ref<Record<string, number>>({})
  // 需要获得焦点的终端 ID（用于从 AI 助手发送代码后自动聚焦）
  const pendingFocusTabId = ref<string>('')
  /**
   * 正在重连的 SSH 窗格 ptyId 集合（UI 按钮 + Agent bridge 共用）。
   * Terminal.vue 据此显示重连中，避免仅组件本地 ref 导致 Agent 触发时 UI 无感。
   */
  const reconnectingPtyIds = ref<Set<string>>(new Set())
  /**
   * 每个窗格成功重连后递增；Terminal.vue watch 后重新 ssh:subscribe（reuseId 下旧回调已挂在已销毁实例上）。
   */
  const reconnectEpochByPtyId = ref<Record<string, number>>({})
  /** 按窗格去重：并发 reconnectSsh / 按钮+Agent 同时触发时共享同一 Promise（非响应式） */
  const inFlightReconnectByPtyId = new Map<string, Promise<{ success: boolean; needsSession?: boolean; cancelled?: boolean; error?: string }>>()
  /**
   * 握手中的重连尝试（窗格 ptyId → attemptId，非响应式）。
   * 关窗格 / 关 tab 时据此当场掐断，不等连接超时；多窗格并发重连各记一条互不覆盖。
   */
  const reconnectAttemptByPtyId = new Map<string, string>()
  /** 助手 composer 聚焦请求（tabId + 递增 seq，供 AiPanel 在打开/切换会话后聚焦输入框） */
  const assistantComposerFocusTabId = ref('')
  const assistantComposerFocusSeq = ref(0)
  /** 终端 AI 侧栏展开请求（tabId + 递增 seq，供 App 层调工作台方法） */
  const terminalAiPanelRevealTabId = ref('')
  const terminalAiPanelRevealSeq = ref(0)
  // 定时任务待执行的 prompt（tabId -> prompt）
  const pendingSchedulerTasks = ref<Record<string, string>>({})
  // 欢迎页 composer → 助手 tab 的 handoff（含附件图片）
  const pendingComposerHandoffs = ref<Record<string, PendingComposerHandoff>>({})
  // 欢迎页 composer 文档暂存（无真实 tab）
  const welcomeComposerDocs = ref<ParsedDocument[]>([])
  // 欢迎页 composer 输入框文字与图片暂存（切 tab 后回到首页恢复）
  const welcomeComposerText = ref('')
  const welcomeComposerImages = ref<PendingImage[]>([])
  // 欢迎页已发起首条对话的 tab，跳过 __onboarding__ 以免打断用户消息
  const assistantSkipOnboardingTabIds = ref<Set<string>>(new Set())
  
  // 屏幕服务实例存储（ptyId -> TerminalScreenService）
  // 使用普通对象而非 ref，因为 TerminalScreenService 实例不需要响应式
  // 注意：改为按 ptyId 存储，以支持分屏模式
  const screenServices = new Map<string, TerminalScreenService>()
  
  // 快照管理器存储（tabId -> TerminalSnapshotManager）
  const snapshotManagers = new Map<string, TerminalSnapshotManager>()

  // 计算属性
  const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value))
  const tabCount = computed(() => tabs.value.length)

  /**
   * Hub 主区当前应显示的助手会话（校验仍存在、是本地助手、且未提升为独立 tab）。
   * 提升为独立 tab 的会话改由 Tab 栏 + activeTabId 驱动，不再算作 Hub 焦点。
   */
  const hubFocusedTab = computed(() => {
    const id = hubFocusedAssistantTabId.value
    if (!id) return undefined
    const tab = tabs.value.find(t => t.id === id)
    if (!tab || tab.type !== 'assistant' || tab.isRemote || tab.isPromoted) return undefined
    return tab
  })

  /**
   * 检测本地系统信息
   */
  function detectLocalSystemInfo(shellPath?: string): SystemInfo {
    const platform = navigator.platform.toLowerCase()
    
    // 根据 shell 路径判断 shell 类型
    const detectShellType = (path?: string): ShellType => {
      if (!path) return 'unknown'
      const lowerPath = path.toLowerCase()
      if (lowerPath.includes('powershell')) return 'powershell'
      if (lowerPath.includes('cmd')) return 'cmd'
      if (lowerPath.includes('bash')) return 'bash'
      if (lowerPath.includes('zsh')) return 'zsh'
      if (lowerPath.includes('sh')) return 'sh'
      return 'unknown'
    }
    
    if (platform.includes('win')) {
      // 与 electron/utils/shell.ts 一致：Windows 默认 PowerShell，不再假设 cmd
      const shell = shellPath ? detectShellType(shellPath) : 'powershell'
      const shellNames: Record<ShellType, string> = {
        powershell: 'PowerShell',
        cmd: 'CMD 命令提示符',
        bash: 'Bash',
        zsh: 'Zsh',
        sh: 'Shell',
        unknown: '终端'
      }
      return {
        os: 'windows',
        shell,
        shellPath: shellPath,
        description: `Windows ${shellNames[shell]}`
      }
    } else if (platform.includes('mac')) {
      const shell = shellPath ? detectShellType(shellPath) : 'zsh'
      return {
        os: 'macos',
        shell,
        shellPath: shellPath || '/bin/zsh',
        description: `macOS ${shell === 'zsh' ? 'Zsh' : shell} 终端`
      }
    } else if (platform.includes('linux')) {
      const shell = shellPath ? detectShellType(shellPath) : 'bash'
      return {
        os: 'linux',
        shell,
        shellPath: shellPath || '/bin/bash',
        description: `Linux ${shell === 'bash' ? 'Bash' : shell} 终端`
      }
    }
    
    return {
      os: 'unknown',
      shell: 'unknown',
      description: '未知终端类型'
    }
  }

  /**
   * 更新终端系统信息
   */
  function updateSystemInfo(tabId: string, systemInfo: Partial<SystemInfo>): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.systemInfo = {
        ...tab.systemInfo,
        ...systemInfo
      } as SystemInfo
    }
  }

  /**
   * 追加终端输出到缓冲区
   */
  const MAX_OUTPUT_LINES = 100
  function appendOutput(tabId: string, output: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    if (!tab.outputBuffer) {
      tab.outputBuffer = []
    }

    // 按行分割并追加
    const lines = output.split('\n')
    tab.outputBuffer.push(...lines)

    // 保持最大行数限制
    if (tab.outputBuffer.length > MAX_OUTPUT_LINES) {
      tab.outputBuffer = tab.outputBuffer.slice(-MAX_OUTPUT_LINES)
    }

    // 检测错误
    detectError(tabId, output)
  }

  /**
   * 检测终端输出中的错误
   */
  const errorPatterns = [
    /error:/i,
    /错误/,
    /failed/i,
    /失败/,
    /exception/i,
    /异常/,
    /not found/i,
    /找不到/,
    /permission denied/i,
    /拒绝访问/,
    /command not found/i,
    /无法识别/,
    /cannot /i,
    /unable to/i
  ]

  function detectError(tabId: string, output: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    // 检查是否包含错误模式
    const hasError = errorPatterns.some(pattern => pattern.test(output))
    if (hasError) {
      tab.lastError = {
        content: stripAnsi(output.trim()).slice(0, 500), // 清理 ANSI 转义码并限制长度
        timestamp: new Date()
      }
    }
  }

  /**
   * 清除错误提示
   */
  function clearError(tabId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.lastError = undefined
    }
  }

  /**
   * 更新选中的文本
   */
  function updateSelectedText(tabId: string, text: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.selectedText = text
    }
  }

  


  /**
   * 去除 ANSI 转义序列
   */
  function stripAnsi(str: string): string {
    return stripAnsiLib(str)
  }

  /**
   * 获取终端最近的输出
   */
  function getRecentOutput(tabId: string, lines: number = 20): string {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.outputBuffer) return ''
    // 清理 ANSI 转义序列后返回
    const rawOutput = tab.outputBuffer.slice(-lines).join('\n')
    return stripAnsi(rawOutput)
  }

  /**
   * 创建新标签页
   */
  async function createTab(
    type: 'local' | 'ssh',
    sshConfig?: { 
      host: string
      port: number
      username: string
      password?: string
      privateKeyPath?: string  // 私钥文件路径
      passphrase?: string  // 私钥密码（可选）
      jumpHost?: JumpHostConfig  // 跳板机配置
      encoding?: string  // 字符编码，默认 utf-8
      sessionId?: string  // SSH 会话 ID（用于重连）
    },
    shell?: string,
    pendingTask?: string
  ): Promise<string> {
    if (type === 'local' && !isWorkbenchAvailable('local')) {
      throw new Error('Local terminal workbench is disabled by OEM features')
    }
    if (type === 'ssh' && !isWorkbenchAvailable('ssh')) {
      throw new Error('SSH terminal workbench is disabled by OEM features')
    }
    const id = uuidv4()
    
    // 生成唯一标题
    const t = i18n.global.t
    let title: string
    if (type === 'local') {
      localTerminalCounter.value++
      const shellName = shell ? (shell.includes('powershell') ? 'PowerShell' : shell.includes('cmd') ? 'CMD' : shell.split(/[/\\]/).pop()) : ''
      title = shellName ? `${shellName} ${localTerminalCounter.value}` : `${t('tabs.localTerminal')} ${localTerminalCounter.value}`
    } else if (sshConfig) {
      const sshKey = `${sshConfig.username}@${sshConfig.host}`
      // 如果有跳板机，在标题中显示
      const jumpSuffix = sshConfig.jumpHost ? ` (via ${sshConfig.jumpHost.host})` : ''
      sshTerminalCounters.value[sshKey] = (sshTerminalCounters.value[sshKey] || 0) + 1
      const count = sshTerminalCounters.value[sshKey]
      title = count > 1 ? `${sshKey}${jumpSuffix} (${count})` : `${sshKey}${jumpSuffix}`
    } else {
      title = t('tabs.sshTerminal')
    }
    
    const tab: TerminalTab = {
      id,
      title,
      type,
      isConnected: false,
      isLoading: true
    }

    if (type === 'ssh' && sshConfig) {
      tab.sshConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username
      }
      // 保存 SSH 会话 ID（用于重连时从 configStore 获取完整配置）
      if (sshConfig.sessionId) {
        tab.sshSessionId = sshConfig.sessionId
      }
    }

    tabs.value.push(tab)
    activeTabId.value = id
    lastTerminalTabId.value = id
    terminalPlaceActive.value = false

    if (pendingTask) {
      pendingSchedulerTasks.value[id] = pendingTask
    }

    // 获取响应式 tab 对象的引用
    const reactiveTab = tabs.value.find(t => t.id === id)!

    // 初始化终端连接
    try {
      if (type === 'local') {
        // 获取本地终端编码设置
        const configStore = useConfigStore()
        const localEncoding = configStore.terminalSettings.localEncoding || 'auto'
        
        // 检查 PATH 是否就绪，如果还没就绪，显示加载提示
        const pathReady = await window.electronAPI.path.isReady()
        if (!pathReady) {
          reactiveTab.loadingMessage = t('terminal.loadingEnv') || '正在加载环境变量...'
        }
        
        // shell 路径以 PTY 实际 spawn 为准（create 返回），不另查 IPC / 不硬编码
        const created = await window.electronAPI.pty.create({
          cols: 80,
          rows: 24,
          shell: shell,
          encoding: localEncoding
        })
        reactiveTab.loadingMessage = undefined  // 清除加载提示
        // await 期间用户可能已关掉这个 tab：此时 reactiveTab 已 detach，
        // 写它无效且新建的 PTY 无人接手，必须显式回收
        if (!tabs.value.some(t => t.id === id)) {
          window.electronAPI.pty.dispose(created.id).catch(() => {})
          return id
        }
        reactiveTab.ptyId = created.id
        reactiveTab.isConnected = true
        reactiveTab.systemInfo = detectLocalSystemInfo(created.shellPath)
        ensureRootSplitLayoutForTab(reactiveTab)
      } else if (type === 'ssh' && sshConfig) {
        const attemptId = uuidv4()
        reactiveTab.connectAttemptId = attemptId
        const sshId = await window.electronAPI.ssh.connect({
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          password: sshConfig.password,
          privateKeyPath: sshConfig.privateKeyPath,  // 私钥文件路径
          passphrase: sshConfig.passphrase,  // 私钥密码
          jumpHost: sshConfig.jumpHost ? toRaw(sshConfig.jumpHost) : undefined,
          encoding: sshConfig.encoding,  // 传递编码配置
          cols: 80,
          rows: 24
        }, { attemptId })
        // 同上：连接期间 tab 被关掉时，刚建立的会话要收掉，避免留下无人使用的连接
        if (!tabs.value.some(t => t.id === id)) {
          window.electronAPI.ssh.disconnect(sshId).catch(() => {})
          return id
        }
        reactiveTab.ptyId = sshId
        reactiveTab.isConnected = true
        // SSH 连接默认假设是 Linux/Unix 系统
        const jumpInfo = sshConfig.jumpHost ? ` (via ${sshConfig.jumpHost.host})` : ''
        reactiveTab.systemInfo = {
          os: 'linux',
          shell: 'bash',
          description: `SSH 连接: ${sshConfig.username}@${sshConfig.host}${jumpInfo}`
        }
        ensureRootSplitLayoutForTab(reactiveTab)
      }
    } catch (error) {
      // tab 已被关掉（含用户主动取消连接）时不报错——界面上已经没有承载它的地方了
      if (!tabs.value.some(t => t.id === id)) return id
      console.error('Failed to create terminal:', error)
      reactiveTab.isConnected = false
      const parsed = formatSshConnectFailure(error, i18n.global.t('terminal.connectionFailed'))
      // 用户取消不是连接失败，不要把 IPC 原文写到这一页上
      if (!parsed.cancelled) {
        reactiveTab.connectionError = parsed.message
      }
    } finally {
      reactiveTab.connectAttemptId = undefined
      reactiveTab.isLoading = false
    }

    return id
  }

  /**
   * 创建独立助手标签页（无终端绑定）
   */
  function createAssistantTab(options?: {
    agentId?: string
    title?: string
    isRemote?: boolean
    remoteChannel?: TerminalTab['remoteChannel']
    activate?: boolean
    /** 直接作为独立 tab 显示在 Tab 栏（而非进入 Hub 焦点流） */
    isPromoted?: boolean
    /** 首页快速发起对话时传入，由 AiPanel 挂载后自动 runAgent */
    initialMessage?: string
    /**
     * 工作台 kind。默认走内置 `assistant`；OEM 岗传自建 kind（如 `sample`）。
     * tab.type 仍为 `assistant`（共享助手会话形态）。
     */
    workbenchKind?: string
  }): string {
    const isCompanion = options?.agentId === COMPANION_TAB_AGENT_ID
    const kindToCheck = isCompanion
      ? 'companion'
      : (options?.workbenchKind || 'assistant')
    if (!isWorkbenchAvailable(kindToCheck)) {
      throw new Error(`Workbench "${kindToCheck}" is unavailable (OEM features / Steam / not registered)`)
    }
    const id = uuidv4()
    const agentId = options?.agentId || `assistant-${id}`
    const t = i18n.global.t
    
    const configStore = useConfigStore()
    const defaultTitle = configStore.agentName || t('tabs.assistant', '助手')

    const tab: TerminalTab = {
      id,
      title: options?.title || defaultTitle,
      type: 'assistant',
      agentId,
      workbenchKind: options?.workbenchKind,
      isConnected: true,
      isLoading: false,
      isRemote: options?.isRemote,
      isPromoted: options?.isPromoted,
      remoteChannel: options?.remoteChannel,
      agentState: {
        isRunning: false,
        steps: [],
        agentId
      }
    }
    
    tabs.value.push(tab)
    if (options?.activate !== false) {
      activeTabId.value = id
      terminalPlaceActive.value = false
    } else if (tab.isRemote) {
      // 远程 tab（Gateway/IM）：无激活 tab 时才自动选中（让用户能看到频道入口）
      if (!activeTabId.value) {
        activeTabId.value = id
        terminalPlaceActive.value = false
      }
    }

    const initialMessage = options?.initialMessage?.trim()
    if (initialMessage) {
      pendingSchedulerTasks.value[id] = initialMessage
    }

    return id
  }

  /**
   * 从指定 tab 的 Agent 会话分叉出一个新的助手 tab（"另开一聊" / "从这里创建任务"）。
   * 后端 fork 完成后再创建前端 tab，确保 Agent 实例和会话历史已经就绪。
   *
   * @param sourceTabId 源 tab ID
   * @param opts.groupIndex 用户点的 group 在 agentTaskGroups 里的 0-based 索引（task fork 用）
   * @param opts.anchorTaskStepId user_task step.id（companion 创建任务用，精确锚定）
   * @returns 新 tab ID，失败返回 null
   */
  async function forkToAssistantTab(sourceTabId: string, opts?: {
    groupIndex?: number
    anchorTaskStepId?: string
  }): Promise<string | null> {
    const sourceTab = tabs.value.find(t => t.id === sourceTabId)
    if (!sourceTab) {
      log.warn(`forkToAssistantTab: source tab not found: ${sourceTabId}`)
      return null
    }
    // 助手 tab 用 agentId 作为 agentKey；终端 tab 用 tabId 作为 agentKey
    const sourceAgentKey = sourceTab.type === 'assistant'
      ? (sourceTab.agentId || sourceTabId)
      : sourceTabId

    const newTabId = uuidv4()
    const newAgentId = `assistant-${newTabId}`
    const t = i18n.global.t
    const titleSuffix = ' · ' + t('ai.fork.titleSuffix', '分支')
    const isCompanionSource = sourceAgentKey === '__companion__'

    let result
    try {
      // 按 source kind 分流：companion 是 N 条 record 合并的关系线，走 extractTaskFromCompanion
      //（异质转化，时间窗口语义）；其它走 forkTask（task → task 同质分叉，截止语义）。
      if (isCompanionSource) {
        // 只传截取所需轻量字段，避免 images/canvas 等导致 IPC 克隆失败
        const sourceSteps = (sourceTab.agentState?.steps ?? []).map(s => ({
          id: s.id,
          type: s.type,
          content: s.content || '',
          timestamp: s.timestamp,
          toolName: s.toolName,
          toolCallId: s.toolCallId,
          success: s.success,
        }))
        result = await window.electronAPI.agent.extractTaskFromCompanion({
          newAgentId,
          anchorTaskIndex: opts?.groupIndex,
          anchorTaskStepId: opts?.anchorTaskStepId,
          titleSuffix,
          sourceSteps,
        })
      } else {
        result = await window.electronAPI.agent.forkTask({
          sourceAgentKey,
          newAgentId,
          untilTaskCount: opts?.groupIndex !== undefined ? opts.groupIndex + 1 : undefined,
          titleSuffix,
          sourceSessionId: sourceTab.agentState?.sessionId,
        })
      }
    } catch (err) {
      log.error('forkToAssistantTab: backend fork failed', err)
      return null
    }
    if (!result) {
      log.warn('forkToAssistantTab: backend returned null (no session data or service unavailable)')
      return null
    }

    // 优先级：① Tab 栏手动重命名（customTitle）② 侧栏/会话 title ③ tab 默认标题
    // companion 升格：标题用锚点那段内容（后端 sourceUserTask 已含后缀），不用「联络 · 分支」
    const forkTitle = isCompanionSource
      ? result.sourceUserTask
      : (() => {
          const sidebarTitle = sourceTab.agentState?.title
          const baseTitle = sourceTab.customTitle || sidebarTitle || sourceTab.title
          return baseTitle + titleSuffix
        })()

    // 分叉后缀写入会话 title（record.userTask 仍来自首条 user_task，不带后缀）
    try {
      await window.electronAPI.history.setConversationTitle(result.newSessionId, forkTitle)
    } catch (e) {
      log.warn('forkToAssistantTab: failed to persist fork title', e)
    }

    const shouldPromote = sourceTab.type === 'assistant' && !!sourceTab.isPromoted

    const tab: TerminalTab = {
      id: newTabId,
      title: forkTitle,
      type: 'assistant',
      agentId: newAgentId,
      isPromoted: shouldPromote,
      isConnected: true,
      isLoading: false,
      agentState: {
        isRunning: false,
        steps: [],
        agentId: newAgentId
      }
    }
    tabs.value.push(tab)
    markAssistantSkipOnboarding(newTabId)

    // 用截断后的 newRecord 恢复 UI（与「加载历史」语义一致）：
    // 显示截断点之前的对话历史 + loadedFromHistory=true（二次 fork 仍走 HistoryService fallback）
    restoreAgentHistory(newTabId, { ...result.newRecord, title: forkTitle })
    // restoreAgentHistory 用 newRecord.id 设置了 sessionId，与后端 Agent 实例一致

    // 继承源会话的呈现形态：Hub 侧栏会话 → focusHubConversation；已提升独立 Tab → promote
    if (shouldPromote) {
      promoteConversationToTab(newTabId)
    } else {
      focusHubConversation(newTabId)
    }

    log.info(`Forked assistant tab: source=${sourceTabId} → new=${newTabId}, sessionId=${result.newSessionId}, groupIndex=${opts?.groupIndex ?? 'n/a'}, anchorTaskStepId=${opts?.anchorTaskStepId ?? 'n/a'}, promoted=${shouldPromote}`)
    return newTabId
  }

  // 当助手名字变更时，同步更新非远程助手标签页的标题。
  // 以「旧名字」为前缀替换为「新名字」，后缀（如 fork 的「· 分支」）保留。
  // 标题不以旧名字开头的 tab（用户完全自定义的 baseTitle）不受影响。
  // 有 customTitle（用户手动重命名）的 tab 跳过，customTitle 优先显示。
  {
    const configStore = useConfigStore()
    watch(() => configStore.agentName, (newName, oldName) => {
      const t = i18n.global.t
      const newBase = newName || t('tabs.assistant', '助手')
      const oldBase = oldName || t('tabs.assistant', '助手')
      for (const tab of tabs.value) {
        if (tab.type === 'assistant' && !tab.isRemote && !tab.customTitle) {
          if (tab.title.startsWith(oldBase)) {
            tab.title = newBase + tab.title.slice(oldBase.length)
          }
        }
      }
    })
  }

  // 联络常驻 tab 标题随语言切换刷新（创建时写入的是当时 locale 的字符串）
  watch(() => i18n.global.locale.value, () => {
    const companion = tabs.value.find(t => t.agentId === COMPANION_TAB_AGENT_ID)
    if (companion && !companion.customTitle) {
      companion.title = i18n.global.t('tabs.reach', '联络')
    }
  })

  /**
   * 创建终端并自动执行 Agent 任务（通用入口）
   * @param prompt Agent 任务指令
   * @param options.type 终端类型，默认 'local'；'headless' 为无终端纯助手（预留）
   * @param options.sshConfig SSH 连接配置（type='ssh' 时必填）
   * @param options.shell 本地终端 shell 路径
   */
  async function createTabWithTask(prompt: string, options?: {
    type?: 'local' | 'ssh' | 'headless'
    sshConfig?: Parameters<typeof createTab>[1]
    shell?: string
  }): Promise<string> {
    const type = options?.type ?? 'local'

    if (type === 'headless') {
      return createAssistantTab()
    }

    const tabId = await createTab(type, options?.sshConfig, options?.shell, prompt)
    return tabId
  }

  /**
   * 关闭标签页
   * @param tabId 标签页 ID
   * @param skipConfirm 是否跳过确认（默认 false）
   */
  async function closeTab(tabId: string, skipConfirm: boolean = false): Promise<boolean> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return false

    // 联络 tab 常驻不可关闭
    if (tab.agentId === COMPANION_TAB_AGENT_ID) return false

    const t = i18n.global.t

    // 如果不跳过确认，检查是否需要确认
    if (!skipConfirm) {
      // 检查 Agent 是否正在运行
      const isAgentRunning = tab.agentState?.isRunning === true

      if (isAgentRunning) {
        // Agent 正在运行，显示警告确认
        const confirmed = await showConfirm({
          type: 'warning',
          title: t('common.confirm'),
          message: t('tabs.confirmCloseAgentRunning'),
        })
        if (!confirmed) return false
      }
    }

    // 连接还在握手中：先掐断，用户点关闭就该立刻停下，而不是等连接超时
    if (tab.connectAttemptId) {
      cancelSshHandshake(tab.connectAttemptId)
      tab.connectAttemptId = undefined
    }
    if (tab.splitLayout) {
      for (const pane of getAllTerminalPanes(tab.splitLayout)) {
        if (pane.connectAttemptId) {
          cancelSshHandshake(pane.connectAttemptId)
          pane.connectAttemptId = undefined
        }
        if (pane.ptyId) cancelPaneReconnectHandshake(pane.ptyId)
      }
    }

    // 清理连接
    if (tab.type === 'assistant') {
      const hosted = tab.splitLayout
        ? getAllTerminalPanes(tab.splitLayout).filter(p => Boolean(p.ptyId))
        : []
      await Promise.all(
        hosted.map(pane => {
          if (!pane.ptyId) return Promise.resolve()
          if (pane.terminalType === 'ssh') {
            return window.electronAPI.ssh.disconnect(pane.ptyId).catch(() => {})
          }
          return window.electronAPI.pty.dispose(pane.ptyId).catch(() => {})
        })
      )
      if (tab.agentId) {
        window.electronAPI.agent.cleanup(tab.agentId).catch(() => {})
      }
    } else if (!tab.isRemote) {
      // 终端 tab：遍历 splitLayout 中所有窗格的 PTY 都 dispose（分屏场景多个 ptyId）。
      // 不能只 dispose tab.ptyId，否则其他窗格的 PTY 会泄漏。
      // 异构分屏：每个窗格的 terminalType 可能不同，按窗格自身类型选 dispose 通道。
      const ptyEntries: Array<{ ptyId: string; type: 'local' | 'ssh' }> = []
      const seen = new Set<string>()
      if (tab.splitLayout) {
        for (const pane of getAllTerminalPanes(tab.splitLayout)) {
          if (pane.ptyId && !seen.has(pane.ptyId)) {
            seen.add(pane.ptyId)
            ptyEntries.push({
              ptyId: pane.ptyId,
              type: (pane.terminalType || tab.type) as 'local' | 'ssh'
            })
          }
        }
      } else if (tab.ptyId) {
        ptyEntries.push({ ptyId: tab.ptyId, type: tab.type as 'local' | 'ssh' })
      }
      await Promise.all(
        ptyEntries.map(({ ptyId, type }) => {
          if (type === 'local') {
            return window.electronAPI.pty.dispose(ptyId).catch(() => {})
          }
          return window.electronAPI.ssh.disconnect(ptyId).catch(() => {})
        })
      )
      // 显式清理 Agent（agentKey = tab.id，与 PTY 生命周期解耦）
      window.electronAPI.agent.cleanup(tab.id).catch(() => {})
    }

    // 清理延迟的 proactive 状态
    clearDeferredProactive(tabId)

    // 移除标签
    const index = tabs.value.findIndex(t => t.id === tabId)
    tabs.value.splice(index, 1)

    // 如果关闭的是当前标签，切换到其他标签
    if (activeTabId.value === tabId) {
      // 未提升本地助手 tab 属于 Hub 内会话，关闭后回到 Hub 首页；
      // 本机 / SSH 只在同类里找下一个，没有则留在终端地方的空页（人还在终端，只是空了）；
      // 已提升 / 远程助手仍按可见 tab 相邻规则。
      const isHubInternalAssistant = tab.type === 'assistant' && !tab.isRemote && !tab.isPromoted
      if (isHubInternalAssistant) {
        activeTabId.value = ''
        hubFocusedAssistantTabId.value = ''
      } else if (isLocalOrSshTab(tab)) {
        const nextTerminal = findAdjacentMatching(index, tabs.value, isLocalOrSshTab)
        if (nextTerminal) {
          activeTabId.value = nextTerminal.id
          lastTerminalTabId.value = nextTerminal.id
        } else {
          activeTabId.value = ''
          terminalPlaceActive.value = true
          hubFocusedAssistantTabId.value = ''
        }
      } else {
        const nextDisplayed = findAdjacentDisplayedTab(index, tabs.value)
        if (nextDisplayed) {
          activeTabId.value = nextDisplayed.id
        } else {
          activeTabId.value = ''
          hubFocusedAssistantTabId.value = ''
        }
      }
    }
    // 如果关闭的是 Hub 焦点会话，清除焦点（主区回欢迎页）
    if (hubFocusedAssistantTabId.value === tabId) {
      hubFocusedAssistantTabId.value = ''
    }

    return true
  }

  /**
   * 创建关联到现有 ptyId 的标签页
   * 用于定时任务执行时，后端已创建终端，前端需要显示
   * @param options.activate 是否激活新 tab（默认 true）。远程 Gateway/IM 创建时传 false，避免抢焦点
   */
  function createTabWithExistingPty(options: {
    ptyId: string
    title: string
    type: 'local' | 'ssh'
    sshConfig?: {
      host: string
      port: number
      username: string
    }
    sshSessionId?: string
    pendingTask?: string  // 创建后自动执行的任务 prompt
    isRemote?: boolean    // 是否为远程 Gateway Agent 标签页
    activate?: boolean   // 是否激活新 tab，默认 true；远程任务创建时传 false 不抢焦点
  }): string {
    const id = uuidv4()
    const shouldActivate = options.activate !== false

    const tab: TerminalTab = {
      id,
      title: options.title,
      type: options.type,
      ptyId: options.ptyId,
      isConnected: true,
      isLoading: false,
      isRemote: options.isRemote
    }

    if (options.type === 'ssh' && options.sshConfig) {
      tab.sshConfig = options.sshConfig
      if (options.sshSessionId) {
        tab.sshSessionId = options.sshSessionId
      }
    }

    ensureRootSplitLayoutForTab(tab)

    tabs.value.push(tab)
    if (shouldActivate) {
      activeTabId.value = id
      if (isLocalOrSshTab(tab)) lastTerminalTabId.value = id
      terminalPlaceActive.value = false
    } else {
      // 不抢焦点：仅当当前没有选中 tab 时才选中新 tab（例如首个 tab）
      if (!activeTabId.value) {
        activeTabId.value = id
        if (isLocalOrSshTab(tab)) lastTerminalTabId.value = id
        terminalPlaceActive.value = false
      }
    }

    // 如果有待执行任务，记录下来让 AiPanel 自动执行
    if (options.pendingTask) {
      pendingSchedulerTasks.value[id] = options.pendingTask
    }

    return id
  }

  /**
   * 获取并清除 tab 的待执行定时任务
   */
  function consumePendingSchedulerTask(tabId: string): string | undefined {
    const task = pendingSchedulerTasks.value[tabId]
    if (task) {
      delete pendingSchedulerTasks.value[tabId]
    }
    return task
  }

  /**
   * 重新连接 SSH 终端。
   *
   * 多屏场景下每个窗格可能连不同主机，重连必须只动指定窗格，不能波及其他人。
   * 调用方传 `targetPtyId`（来自 Terminal.vue 的 props.ptyId）就能精确定位窗格。
   * 不传时退回老路径——按 tab.ptyId 找窗格，兼容老调用点 / 单屏场景。
   *
   * 返回 { success, needsSession } 指示结果。
   */
  function isPtyReconnecting(ptyId: string | undefined): boolean {
    return !!ptyId && reconnectingPtyIds.value.has(ptyId)
  }

  function markPtyReconnecting(ptyId: string, on: boolean): void {
    const next = new Set(reconnectingPtyIds.value)
    if (on) next.add(ptyId)
    else next.delete(ptyId)
    reconnectingPtyIds.value = next
  }

  function bumpReconnectEpoch(ptyId: string): void {
    reconnectEpochByPtyId.value = {
      ...reconnectEpochByPtyId.value,
      [ptyId]: (reconnectEpochByPtyId.value[ptyId] || 0) + 1
    }
  }

  async function reconnectSsh(
    tabId: string,
    targetPtyId?: string
  ): Promise<{ success: boolean; needsSession?: boolean; cancelled?: boolean; error?: string }> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) {
      console.error('Cannot reconnect: tab not found')
      return { success: false, error: 'tab not found' }
    }

    // 优先按 targetPtyId 找窗格，找不到再退回 tab.ptyId
    const lookupPtyId = targetPtyId || tab.ptyId
    if (!lookupPtyId) {
      return { success: false, error: 'no ptyId to reconnect' }
    }

    const existing = inFlightReconnectByPtyId.get(lookupPtyId)
    if (existing) {
      // 命中新开窗格的 pending 握手：id 用的是 reuseId，对外不变，
      // 不必再走 disconnect / remap / bumpEpoch。将来若 pending 会换 id，必须改走完整路径。
      return existing
    }

    const run = doReconnectSsh(tab, tabId, lookupPtyId)
    inFlightReconnectByPtyId.set(lookupPtyId, run)
    try {
      return await run
    } finally {
      inFlightReconnectByPtyId.delete(lookupPtyId)
    }
  }

  /** 掐断一次仍在握手中的 SSH 连接尝试（已完成时后端返回 false，无副作用） */
  function cancelSshHandshake(attemptId: string): void {
    window.electronAPI.ssh.cancelConnect(attemptId).catch(() => {})
  }

  /** 掐断该窗格正在进行的重连握手（用户关窗格 / 关 tab 时调用） */
  function cancelPaneReconnectHandshake(ptyId: string): void {
    const attemptId = reconnectAttemptByPtyId.get(ptyId)
    if (!attemptId) return
    reconnectAttemptByPtyId.delete(ptyId)
    cancelSshHandshake(attemptId)
  }

  async function doReconnectSsh(
    tab: TerminalTab,
    tabId: string,
    lookupPtyId: string
  ): Promise<{ success: boolean; needsSession?: boolean; cancelled?: boolean; error?: string }> {
    const paneNode = tab.splitLayout
      ? getAllTerminalPanes(tab.splitLayout).find(p => p.ptyId === lookupPtyId)
      : undefined

    // SSH 信息优先取窗格的；缺失时退回 tab 级（兼容窗格还没 SSH 元数据的边界场景）
    const terminalType = paneNode?.terminalType || tab.type
    const sshSessionId = paneNode?.sshSessionId || tab.sshSessionId

    if (terminalType !== 'ssh') {
      console.error('Cannot reconnect: pane/tab is not SSH type')
      return { success: false, error: 'pane is not SSH type' }
    }
    if (!sshSessionId) {
      console.warn('Cannot reconnect: no sessionId saved (session was not saved)')
      return { success: false, needsSession: true, error: 'session was not saved' }
    }

    const configStore = useConfigStore()
    const session = configStore.sshSessions.find(s => s.id === sshSessionId)
    if (!session) {
      console.error('Cannot reconnect: session not found in config')
      return { success: false, needsSession: true, error: 'session not found in config' }
    }

    const oldPtyId = paneNode?.ptyId || tab.ptyId || lookupPtyId
    markPtyReconnecting(oldPtyId, true)

    // 没找到窗格节点说明走的是 tab 级老路径，仍按原方式标 tab.isLoading。
    const wholeTabReconnect = !paneNode
    if (wholeTabReconnect) {
      tab.isLoading = true
      tab.isConnected = false
    }

    let bumpPtyId: string | undefined
    const attemptId = uuidv4()
    reconnectAttemptByPtyId.set(oldPtyId, attemptId)
    try {
      if (oldPtyId) {
        try {
          await window.electronAPI.ssh.disconnect(oldPtyId)
        } catch (e) {
          // 忽略断开连接的错误
        }
      }

      const jumpHost = configStore.getEffectiveJumpHost(session)

      // 重连复用旧会话实例 id：对外身份不变，只换底层 ssh2 连接
      const sshId = await window.electronAPI.ssh.connect({
        host: session.host,
        port: session.port,
        username: session.username,
        password: session.password,
        privateKeyPath: session.privateKeyPath,
        passphrase: session.passphrase,
        jumpHost: jumpHost ? toRaw(jumpHost) : undefined,
        encoding: session.encoding || 'utf-8',
        cols: 80,
        rows: 24
      }, oldPtyId ? { reuseId: oldPtyId, attemptId } : { attemptId })

      // ssh.connect 是异步的——await 期间用户可能关了窗格 / 切了 tab / 关了整个 tab。
      // 这里要重新校验 paneNode 还在 splitLayout 里、tab 还在 tabs 里，否则我们刚连上的
      // sshId 没人用，得显式 disconnect 避免 ghost 连接泄漏（mutate 已 detach 的 paneNode
      // 也是无效的，UI 不会更新）。
      const tabStillAlive = tabs.value.some(t => t.id === tabId)
      const paneStillAttached = paneNode
        && tab.splitLayout
        && getAllTerminalPanes(tab.splitLayout).includes(paneNode)

      if (!tabStillAlive || (paneNode && !paneStillAttached)) {
        try {
          await window.electronAPI.ssh.disconnect(sshId)
        } catch {
          // 忽略：清理失败不阻塞调用方
        }
        return { success: false, error: 'pane or tab closed during reconnect' }
      }

      // 1. 对外 id 不变时无需改 pane.ptyId；兜底：若未传 reuseId（无旧 id）则写入新 id
      if (paneNode && paneNode.ptyId !== sshId) {
        paneNode.ptyId = sshId
      }

      // 2. tab 级镜像：重连的是 active 窗格（或 tab 级老路径）时同步连接态
      //    多屏下重连非 active 窗格不应改动 tab.ptyId
      if (!paneNode || paneNode.isActive) {
        if (tab.ptyId !== sshId) {
          tab.ptyId = sshId
        }
        tab.isConnected = true
        const jumpInfo = jumpHost ? ` (via ${jumpHost.host})` : ''
        tab.systemInfo = {
          os: 'linux',
          shell: 'bash',
          description: `SSH 连接: ${session.username}@${session.host}${jumpInfo}`
        }
      }

      // 3. 单屏 / 兜底：splitLayout 缺失时初始化；存在但仅 1 个 terminal 子节点时同步它
      if (!paneNode) {
        if (tab.splitLayout?.children?.length === 1 && tab.splitLayout.children[0].type === 'terminal') {
          tab.splitLayout.children[0].ptyId = sshId
          tab.splitLayout.children[0].sshConfig = tab.sshConfig
          tab.splitLayout.children[0].sshSessionId = tab.sshSessionId
        } else if (!tab.splitLayout) {
          ensureRootSplitLayoutForTab(tab)
        }
      }

      // 4. 底层连接已换：运行中 Agent 需重绑同 id 的输出监听（id 不变也会丢旧回调）
      if (oldPtyId) {
        try {
          await window.electronAPI.agent.remapPtyId(tabId, oldPtyId, sshId)
        } catch {
          // Agent 未运行或不存在时无妨
        }
      }

      if (paneNode) {
        paneNode.isConnecting = false
        paneNode.connectionError = undefined
      }
      bumpPtyId = sshId
      return { success: true }
    } catch (error) {
      // tab / 窗格已被关掉（含用户主动取消）：连接是我们自己掐断的，不算重连失败
      const paneDetached = paneNode
        && (!tab.splitLayout || !getAllTerminalPanes(tab.splitLayout).includes(paneNode))
      if (!tabs.value.some(t => t.id === tabId) || paneDetached) {
        return { success: false, error: 'pane or tab closed during reconnect' }
      }
      console.error('Failed to reconnect SSH:', error)
      if (wholeTabReconnect) {
        tab.isConnected = false
      }
      const parsed = formatSshConnectFailure(error, i18n.global.t('terminal.connectionFailed'))
      if (parsed.cancelled) {
        if (paneNode) paneNode.isConnecting = false
        return { success: false, cancelled: true }
      }
      if (paneNode) {
        paneNode.isConnecting = false
        paneNode.connectionError = parsed.message
      }
      return { success: false, error: parsed.message }
    } finally {
      markPtyReconnecting(oldPtyId, false)
      if (reconnectAttemptByPtyId.get(oldPtyId) === attemptId) {
        reconnectAttemptByPtyId.delete(oldPtyId)
      }
      if (wholeTabReconnect) {
        tab.isLoading = false
      }
      // 在清除 reconnecting 之后再 bump，避免 Terminal watch 被 isReconnecting 挡住
      if (bumpPtyId) bumpReconnectEpoch(bumpPtyId)
    }
  }

  /**
   * 切换标签页
   */
  function setActiveTab(tabId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return
    todosActive.value = false
    activeTabId.value = tabId
    terminalPlaceActive.value = false
    if (isLocalOrSshTab(tab)) lastTerminalTabId.value = tabId
    setAgentCompletedUnseen(tabId, false)
    if (tab.type === 'assistant') {
      requestAssistantComposerFocus(tabId)
    }
  }

  function requestAssistantComposerFocus(tabId: string): void {
    assistantComposerFocusTabId.value = tabId
    assistantComposerFocusSeq.value += 1
  }

  /**
   * 请求展开某个终端 tab 的 AI 侧栏。
   * 从最近对话点开一条终端会话时用——面板收着的话，切过去看着就像没跳。
   * 面板归工作台组件所有，这里只发信号，由 App 层执行。
   */
  function requestTerminalAiPanelReveal(tabId: string): void {
    terminalAiPanelRevealTabId.value = tabId
    terminalAiPanelRevealSeq.value += 1
  }

  /**
   * LRU 会话池淘汰：Hub 内非提升助手 tab 上限 HUB_SESSION_LIMIT。
   * 超出时淘汰「最久未聚焦 且 未运行 且 未待确认」的会话，触发 agent.cleanup + 移除 tab。
   * 当前焦点 tab 和新建的 tab（tabId）豁免。
   */
  const HUB_SESSION_LIMIT = 5

  /** 预热单条 steps 上限：超过则不预挂 tab（避免超长会话打爆内存） */
  const WARM_HISTORY_MAX_STEPS = 80

  function evictHubSessionsIfNeeded(keepTabId: string): void {
    const candidates = tabs.value.filter(
      t => t.type === 'assistant' && !t.isRemote && !t.isPromoted && t.id !== keepTabId
    )
    if (candidates.length < HUB_SESSION_LIMIT) return

    const evictable = candidates.filter(t => {
      const meta = deriveTabAgentUiMeta(t.agentState)
      return !meta.isRunning && !meta.needsAttention
    })

    // 按最近聚焦时间升序（最久未聚焦优先）
    evictable.sort((a, b) => (a.lastFocusedAt ?? 0) - (b.lastFocusedAt ?? 0))

    const toEvict = evictable.slice(0, candidates.length - HUB_SESSION_LIMIT + 1)
    for (const tab of toEvict) {
      if (tab.agentId) {
        window.electronAPI.agent.cleanup(tab.agentId).catch(() => {})
      }
      const idx = tabs.value.findIndex(t => t.id === tab.id)
      if (idx >= 0) tabs.value.splice(idx, 1)
      log.debug(`[LRU] Evicted hub session tab: ${tab.id}`)
    }
  }

  /**
   * 在 Hub 主区（首页视图）聚焦某个本地助手会话，而非将其作为独立 tab 激活。
   * 清空 activeTabId（停留首页视图）并设焦点，使主区渲染该会话的 AssistantWorkbench。
   * 同时触发 LRU 淘汰，防止会话池无限增长。
   */
  function focusHubConversation(tabId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab || tab.type !== 'assistant') return
    const previousHubId = hubFocusedAssistantTabId.value
    if (previousHubId && previousHubId !== tabId) {
      setAgentCompletedUnseen(previousHubId, false)
    }
    tab.lastFocusedAt = Date.now()
    hubFocusedAssistantTabId.value = tabId
    todosActive.value = false
    activeTabId.value = ''
    terminalPlaceActive.value = false
    setAgentCompletedUnseen(tabId, false)
    evictHubSessionsIfNeeded(tabId)
    requestAssistantComposerFocus(tabId)
  }

  /** 清除 Hub 焦点会话，主区回到欢迎页 */
  function clearHubFocus(): void {
    hubFocusedAssistantTabId.value = ''
  }

  /**
   * 将 Hub 内的本地助手会话提升为独立 Tab（出现在 Tab 栏、豁免 LRU 淘汰）。
   * 若会话已是 isPromoted 则只激活；若不存在则用历史记录新建。
   */
  function promoteConversationToTab(tabId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return
    tab.isPromoted = true
    // 清除 Hub 焦点（它将以独立 tab 形式存在），切换过去
    if (hubFocusedAssistantTabId.value === tabId) {
      hubFocusedAssistantTabId.value = ''
    }
    setActiveTab(tabId)
  }

  /** 回到首页欢迎页（保留已打开的 tab，仅切换视图，并清除 Hub 焦点会话） */
  function goToHome(): void {
    todosActive.value = false
    activeTabId.value = ''
    hubFocusedAssistantTabId.value = ''
    terminalPlaceActive.value = false
  }

  /** 切回任务区：仅退出可见 tab / 待办 / 空终端页，保留 Hub 焦点会话（侧栏「新建对话」等仍用 goToHome） */
  function focusTaskArea(): void {
    const leavingTerminalPlace = terminalPlaceActive.value
    terminalPlaceActive.value = false
    if (!activeTabId.value && !todosActive.value && !leavingTerminalPlace) return
    todosActive.value = false
    activeTabId.value = ''
    const hubId = hubFocusedAssistantTabId.value
    if (!hubId) return
    const tab = tabs.value.find(t => t.id === hubId)
    if (!tab || tab.type !== 'assistant' || tab.isRemote || tab.isPromoted) {
      hubFocusedAssistantTabId.value = ''
      return
    }
    setAgentCompletedUnseen(hubId, false)
    requestAssistantComposerFocus(hubId)
  }

  /** 打开待办固定面（与联络并列的伪 Tab，非 Agent 会话）；保留 Hub 焦点，切回任务区可恢复 */
  function openTodos(): void {
    todosActive.value = true
    activeTabId.value = ''
    terminalPlaceActive.value = false
  }

  const terminalTabs = computed(() => tabs.value.filter(isLocalOrSshTab))

  const shellPlace = computed<'tasks' | 'companion' | 'terminal' | 'todos'>(() => {
    if (todosActive.value) return 'todos'
    const tab = tabs.value.find(t => t.id === activeTabId.value)
    if (tab?.agentId === COMPANION_TAB_AGENT_ID) return 'companion'
    if (tab && isLocalOrSshTab(tab)) return 'terminal'
    if (terminalPlaceActive.value && !activeTabId.value) return 'terminal'
    return 'tasks'
  })

  /** 壳层落点快照：谁在眼前由这几个状态共同决定，别处不要各自拼 */
  const conversationSurface = computed<ConversationSurfaceState>(() => ({
    activeTabId: activeTabId.value,
    hubFocusedAssistantTabId: hubFocusedAssistantTabId.value,
    todosActive: todosActive.value,
    terminalPlaceActive: terminalPlaceActive.value,
  }))

  /**
   * 按快照回到某个落点（后退 / 前进用）。
   * 目标 tab 已经不在了就返回 false，调用方应跳过这条继续找更早的。
   */
  function restoreConversationSurface(surface: ConversationSurfaceState): boolean {
    const nextActive = surface.activeTabId
      ? tabs.value.find(t => t.id === surface.activeTabId)
      : undefined
    if (surface.activeTabId && !nextActive) return false

    const nextHub = surface.hubFocusedAssistantTabId
      ? tabs.value.find(t => t.id === surface.hubFocusedAssistantTabId)
      : undefined
    if (
      surface.hubFocusedAssistantTabId &&
      !nextHub &&
      !surface.activeTabId &&
      !surface.todosActive &&
      !surface.terminalPlaceActive
    ) {
      return false
    }

    todosActive.value = !!surface.todosActive
    terminalPlaceActive.value = !!surface.terminalPlaceActive && !nextActive
    activeTabId.value = nextActive ? nextActive.id : ''
    hubFocusedAssistantTabId.value = nextHub ? nextHub.id : ''

    if (nextActive) {
      if (isLocalOrSshTab(nextActive)) lastTerminalTabId.value = nextActive.id
      setAgentCompletedUnseen(nextActive.id, false)
      if (nextActive.type === 'assistant') requestAssistantComposerFocus(nextActive.id)
    } else if (nextHub && !todosActive.value && !terminalPlaceActive.value) {
      nextHub.lastFocusedAt = Date.now()
      setAgentCompletedUnseen(nextHub.id, false)
      requestAssistantComposerFocus(nextHub.id)
    }
    return true
  }

  /** 点侧栏「终端」：回到上次本机 / SSH 工作台；一个都没有才进空页 */
  function focusTerminalPlace(): void {
    todosActive.value = false
    const last = lastTerminalTabId.value
      ? tabs.value.find(t => t.id === lastTerminalTabId.value && isLocalOrSshTab(t))
      : undefined
    if (last) {
      setActiveTab(last.id)
      return
    }
    for (let i = tabs.value.length - 1; i >= 0; i--) {
      if (isLocalOrSshTab(tabs.value[i])) {
        setActiveTab(tabs.value[i].id)
        return
      }
    }
    activeTabId.value = ''
    terminalPlaceActive.value = true
  }

  function focusCompanionPlace(): void {
    const id = ensureCompanionTab()
    if (id) setActiveTab(id)
  }

  /**
   * 更新标签标题（系统自动更新，不影响用户自定义标题）
   */
  function updateTabTitle(tabId: string, title: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.title = title
    }
  }

  /**
   * 用户手动重命名标签页。传入空字符串则清除自定义名称，恢复自动标题。
   */
  function renameTab(tabId: string, name: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.customTitle = name.trim() || undefined
    }
  }

  /**
   * 更新连接状态
   */
  function updateConnectionStatus(tabId: string, isConnected: boolean): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.isConnected = isConnected
    }
  }

  /**
   * 直接按 ptyId + 终端类型写入数据（分屏安全）
   *
   * 调用方需要持有 ptyId（Terminal 组件内部、Agent IPC 等场景）。
   * 不要用 tab.ptyId 路由：分屏后 tab.ptyId 是"当前激活窗格的 ptyId"，
   * 而 Terminal 组件 onData 要写自己（可能是非激活窗格）的 pty。
   */
  async function writeToPty(ptyId: string, terminalType: 'local' | 'ssh', data: string): Promise<void> {
    if (!ptyId) return
    if (terminalType === 'local') {
      await window.electronAPI.pty.write(ptyId, data)
    } else {
      await window.electronAPI.ssh.write(ptyId, data)
    }
  }

  /**
   * 直接按 ptyId + 终端类型 resize（分屏安全，理由同 writeToPty）
   */
  async function resizePty(ptyId: string, terminalType: 'local' | 'ssh', cols: number, rows: number): Promise<void> {
    if (!ptyId) return
    if (terminalType === 'local') {
      await window.electronAPI.pty.resize(ptyId, cols, rows)
    } else {
      await window.electronAPI.ssh.resize(ptyId, cols, rows)
    }
  }

  /**
   * 向 tab 当前激活窗格写入数据（外部调用接口：AI Panel、批量命令等）
   *
   * 分屏时路由到激活窗格的 ptyId（不再用 tab.ptyId，因为它在 setActivePaneInTab 时
   * 不会同步更新）。
   */
  async function writeToTerminal(tabId: string, data: string): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return
    const ptyId = getActivePtyId(tab)
    if (!ptyId) return
    await writeToPty(ptyId, tab.type as 'local' | 'ssh', data)
  }

  /**
   * 调整 tab 当前激活窗格的终端大小（保留给外部调用；Terminal 组件内部应用 resizePty）
   */
  async function resizeTerminal(tabId: string, cols: number, rows: number): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return
    const ptyId = getActivePtyId(tab)
    if (!ptyId) return
    await resizePty(ptyId, tab.type as 'local' | 'ssh', cols, rows)
  }

  /**
   * 创建分屏
   * 将当前激活的终端分割为两个窗格
   *
   * @param direction horizontal=左右、vertical=上下
   * @param target    新窗格连接哪里：
   *                  - 不传 / `{kind:'inherit'}`：复用当前激活窗格的连接（默认，与历史行为一致）
   *                  - `{kind:'local'}`：新开本地 shell
   *                  - `{kind:'ssh', sessionId}`：新开已配置的 SSH 会话
   */
  /** 最近一次分屏失败的具体原因——给 Agent / UI 调用方读取（非 reactive，仅模块内单值缓存） */
  let lastSplitError: string | null = null
  let lastSplitCancelled = false
  function getLastSplitError(): string | null { return lastSplitError }
  function wasLastSplitCancelled(): boolean { return lastSplitCancelled }

  function resetLastSplitOutcome(): void {
    lastSplitError = null
    lastSplitCancelled = false
  }

  function recordConnectFailure(error: unknown): { cancelled: boolean; message: string } {
    const parsed = formatSshConnectFailure(error, i18n.global.t('terminal.connectionFailed'))
    if (parsed.cancelled) {
      lastSplitCancelled = true
      lastSplitError = null
    } else {
      lastSplitCancelled = false
      lastSplitError = parsed.message
    }
    return parsed
  }

  /** 这一页里是否已有一扇自己在说连接失败——有的话就不要再弹窗 */
  function tabHasPaneConnectionError(tabId: string): boolean {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout) return false
    return getAllTerminalPanes(tab.splitLayout).some(p => Boolean(p.connectionError))
  }

  async function splitTerminal(
    direction: 'horizontal' | 'vertical',
    target: SplitTarget = { kind: 'inherit' },
    tabId?: string
  ): Promise<string | null> {
    resetLastSplitOutcome()

    // tabId 缺省时操作 activeTab（UI 用户从右键菜单点击时走这条）
    // 显式传 tabId 时操作那个 tab——split-pane-handler 给 Agent 工具调用走这条，
    // 锁定到 Agent 自己所在的 tab，不会跟着用户切的 activeTab 漂移。
    const currentTab = tabId
      ? tabs.value.find(t => t.id === tabId)
      : activeTab.value

    if (!currentTab) {
      lastSplitError = tabId ? `tab not found: ${tabId}` : 'no active tab'
      log.warn(lastSplitError)
      return null
    }

    if (currentTab.type === 'assistant') {
      const hosted = currentTab.splitLayout
        ? getAllTerminalPanes(currentTab.splitLayout).filter(p => p.ptyId).length
        : 0
      if (hosted === 0 && !currentTab.ptyId) {
        lastSplitError = 'assistant tab has no terminal yet; open one first'
        log.warn('Cannot split assistant tab before opening a terminal')
        return null
      }
    }

    // 兜底：老数据可能无 splitLayout，补齐
    if (!currentTab.splitLayout) {
      ensureRootSplitLayoutForTab(currentTab)
    }
    if (!currentTab.splitLayout) {
      lastSplitError = 'tab has no splitLayout'
      log.warn('Cannot split: tab has no ptyId or splitLayout')
      return null
    }

    assertTabLayoutInvariant(currentTab)

    const activePane = findActivePaneInLayout(currentTab.splitLayout)
      ?? getAllTerminalPanes(currentTab.splitLayout)[0]
    if (!activePane || activePane.type !== 'terminal') {
      lastSplitError = 'no terminal pane in layout to split on'
      log.warn('No terminal pane in layout to split on')
      return null
    }
    log.info(
      `Split start direction=${direction} target=${target.kind} ` +
      `activePane.id=${activePane.id} activePane.ptyId=${activePane.ptyId} ` +
      `existingPanes=${getAllTerminalPanes(currentTab.splitLayout).map(p => `${p.id}:${p.ptyId}`).join(',')}`
    )

    // 解析目标连接源：inherit 时回退到激活窗格的连接（不依赖 tab 顶层字段，
    // 因为分屏后 tab.type/sshConfig 只跟 root 兼容，激活窗格的连接才是真相）
    const resolved = resolveSplitTarget(target, activePane)
    if (!resolved) {
      lastSplitError = lastSplitError || 'failed to resolve split target'
      return null
    }

    // 先出窗格再握手：界面立刻能看到「正在连接」，不要干等连上才切开。
    const edge = direction === 'horizontal' ? 'right' : 'bottom'
    const newPane = placePendingSplitPane(currentTab, activePane, edge, resolved)
    if (!newPane) {
      lastSplitError = lastSplitError || 'failed to place new pane'
      return null
    }

    const newPtyId = await connectPendingSplitPane(currentTab, newPane, resolved)
    log.info(
      `Split done direction=${direction} activePtyId=${activePane.ptyId} newPtyId=${newPtyId} ` +
      `panes=${getAllTerminalPanes(currentTab.splitLayout).map(p => p.ptyId).join(',')}`
    )
    const live = findPaneById(currentTab.splitLayout, newPane.id)
    // 窗格已经在，连不上也留着给用户看；Agent 仍拿失败，避免当成已连上接着下命令
    // 用户取消不是失败：这一扇多半已经关了，不要把占位 id 当成连上了
    return lastSplitCancelled || live?.connectionError ? null : newPtyId
  }

  /**
   * 在指定窗格的某一边新开一扇（本机或指定主机）。
   */
  async function splitAtEdge(
    tabId: string,
    anchorPaneId: string,
    edge: PaneEdge,
    target: SplitTarget
  ): Promise<string | null> {
    resetLastSplitOutcome()
    const currentTab = tabs.value.find(t => t.id === tabId)
    if (!currentTab) {
      lastSplitError = `tab not found: ${tabId}`
      log.warn(lastSplitError)
      return null
    }
    if (currentTab.type === 'assistant') {
      lastSplitError = 'assistant tab does not accept edge split'
      return null
    }
    if (!currentTab.splitLayout) {
      ensureRootSplitLayoutForTab(currentTab)
    }
    if (!currentTab.splitLayout) {
      lastSplitError = 'tab has no splitLayout'
      return null
    }

    let anchor = findPaneById(currentTab.splitLayout, anchorPaneId)
    if (!anchor) {
      anchor = getAllTerminalPanes(currentTab.splitLayout).find(p => p.ptyId === anchorPaneId) ?? null
    }
    if (!anchor || anchor.type !== 'terminal') {
      lastSplitError = 'no terminal pane to split on'
      return null
    }

    const resolved = resolveSplitTarget(target, anchor)
    if (!resolved) {
      lastSplitError = lastSplitError || 'failed to resolve split target'
      return null
    }
    const newPane = placePendingSplitPane(currentTab, anchor, edge, resolved)
    if (!newPane) {
      lastSplitError = lastSplitError || 'failed to place new pane at edge'
      return null
    }

    const newPtyId = await connectPendingSplitPane(currentTab, newPane, resolved)
    const live = findPaneById(currentTab.splitLayout, newPane.id)
    return lastSplitCancelled || live?.connectionError ? null : newPtyId
  }

  /**
   * 把已有窗格拖到另一扇的边上。只在同一页里搬。
   */
  function movePaneInTab(
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    edge: PaneEdge
  ): boolean {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout || tab.type === 'assistant') return false
    if (sourcePaneId === targetPaneId) return false

    const ok = movePaneToEdgeInTree(tab.splitLayout, sourcePaneId, targetPaneId, edge, uuidv4())
    if (!ok) return false

    updatePaneLabels(tab.splitLayout)
    const moved = findPaneById(tab.splitLayout, sourcePaneId)
      ?? getAllTerminalPanes(tab.splitLayout).find(p => p.id === sourcePaneId)
    if (moved) {
      setActivePaneInTab(tabId, moved.id)
      if (moved.ptyId) tab.ptyId = moved.ptyId
    }
    assertTabLayoutInvariant(tab)
    return true
  }

  /**
   * 在指定 tab 上开一台真终端（不分屏）。
   * 助手没有第一扇时用它换台；已有窗格时退化为再开一扇（默认上下分）。
   */
  async function openTerminalOnTab(
    tabId: string,
    target: SplitTarget = { kind: 'local' }
  ): Promise<string | null> {
    resetLastSplitOutcome()
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) {
      lastSplitError = `tab not found: ${tabId}`
      log.warn(lastSplitError)
      return null
    }

    const existing = tab.splitLayout
      ? getAllTerminalPanes(tab.splitLayout).filter(p => Boolean(p.ptyId))
      : []
    if (existing.length > 0) {
      const splitTarget: SplitTarget = target.kind === 'inherit' ? { kind: 'local' } : target
      return splitTerminal('vertical', splitTarget, tabId)
    }

    const seed: SplitPane = { id: 'seed', type: 'terminal', terminalType: 'local' }
    const resolved = resolveSplitTarget(target.kind === 'inherit' ? { kind: 'local' } : target, seed)
    if (!resolved) return null

    const created = await createTerminalInstanceForTarget(resolved)
    if (!created.id) return null

    tab.ptyId = created.id
    tab.isConnected = true
    tab.connectionError = undefined
    if (resolved.terminalType === 'ssh') {
      tab.sshConfig = resolved.sshConfig
      tab.sshSessionId = resolved.sshSessionId
      tab.systemInfo = {
        os: 'linux',
        shell: 'bash',
        description: resolved.sshConfig
          ? `SSH 连接: ${resolved.sshConfig.username}@${resolved.sshConfig.host}`
          : 'SSH'
      }
    } else {
      tab.sshConfig = undefined
      tab.sshSessionId = undefined
      tab.systemInfo = detectLocalSystemInfo()
    }
    ensureRootSplitLayoutForTab(tab, resolved.terminalType)
    const leaf = tab.splitLayout ? getAllTerminalPanes(tab.splitLayout)[0] : undefined
    if (leaf) {
      leaf.ptyId = created.id
      leaf.terminalType = resolved.terminalType
      leaf.sshConfig = resolved.sshConfig
      leaf.sshSessionId = resolved.sshSessionId
      if (resolved.label) leaf.label = resolved.label
    }
    assertTabLayoutInvariant(tab)
    log.info(`Opened terminal on tab=${tabId} ptyId=${created.id} type=${resolved.terminalType}`)
    return created.id
  }

  /**
   * 把 SplitTarget 解析成创建 PTY 所需的全部参数。
   *
   * 失败时返回 null（如 ssh sessionId 不存在）。inherit 模式回退到 activePane 的连接：
   * - 激活窗格是 ssh → 复用其 sshSessionId 重新 ssh.connect 一次（不会复用同一个 PTY，
   *   Agent / 用户预期是"新开一个相同的连接"）
   * - 激活窗格是 local → 走本地 shell
   */
  function resolveSplitTarget(
    target: SplitTarget,
    activePane: SplitPane
  ): {
    terminalType: 'local' | 'ssh'
    sshSessionId?: string
    sshConfig?: { host: string; port: number; username: string }
    label?: string
  } | null {
    const configStore = useConfigStore()

    const finalTarget: SplitTarget = (() => {
      if (target.kind === 'inherit') {
        if (activePane.terminalType === 'ssh' && activePane.sshSessionId) {
          return { kind: 'ssh' as const, sessionId: activePane.sshSessionId }
        }
        return { kind: 'local' as const }
      }
      return target
    })()

    if (finalTarget.kind === 'local') {
      return { terminalType: 'local' }
    }

    const session = configStore.sshSessions.find(s => s.id === finalTarget.sessionId)
    if (!session) {
      lastSplitError = `SSH session not found: ${finalTarget.sessionId}`
      log.error('SSH session not found:', finalTarget.sessionId)
      return null
    }
    return {
      terminalType: 'ssh',
      sshSessionId: session.id,
      sshConfig: { host: session.host, port: session.port, username: session.username },
      label: session.name
    }
  }

  type ResolvedSplitTarget = {
    terminalType: 'local' | 'ssh'
    sshSessionId?: string
    sshConfig?: { host: string; port: number; username: string }
    label?: string
  }

  /** 先把空窗格嵌进布局（正在连接），握手成功后再挂终端。 */
  function placePendingSplitPane(
    currentTab: TerminalTab,
    anchor: SplitPane,
    edge: PaneEdge,
    resolved: ResolvedSplitTarget
  ): SplitPane | null {
    if (!currentTab.splitLayout) return null
    const pendingPtyId = uuidv4()
    const newPane: SplitPane = {
      id: uuidv4(),
      type: 'terminal',
      ptyId: pendingPtyId,
      terminalType: resolved.terminalType,
      sshConfig: resolved.sshConfig,
      sshSessionId: resolved.sshSessionId,
      label: resolved.label || i18n.global.t('terminal.split.label.new'),
      isActive: true,
      size: 50,
      isConnecting: true
    }
    if (!splitLeafAtEdge(currentTab.splitLayout, anchor.id, newPane, edge, uuidv4())) {
      return null
    }
    currentTab.ptyId = pendingPtyId
    updatePaneLabels(currentTab.splitLayout)
    setActivePaneInTab(currentTab.id, newPane.id)
    assertTabLayoutInvariant(currentTab)
    // 进布局后拿树上那份，后面改状态才看得见（不能拿刚 new 出来的那份去比对）
    return findPaneById(currentTab.splitLayout, newPane.id) ?? newPane
  }

  /**
   * 对已插入的窗格做握手。失败写在这一扇上并仍返回占位 id，
   * 好让拖过来的人看见窗格、不要再弹一层超时。
   */
  async function connectPendingSplitPane(
    tab: TerminalTab,
    pane: SplitPane,
    resolved: ResolvedSplitTarget
  ): Promise<string | null> {
    const paneId = pane.id
    const lookupPtyId = pane.ptyId

    const run = (async (): Promise<{ success: boolean; error?: string }> => {
      const attemptId = resolved.terminalType === 'ssh' ? uuidv4() : undefined
      if (attemptId) pane.connectAttemptId = attemptId
      const created = await createTerminalInstanceForTarget(resolved, {
        reuseId: pane.ptyId,
        attemptId
      })
      const connectedId = created.id
      const live = tab.splitLayout
        ? findPaneById(tab.splitLayout, paneId)
        : null
      if (!live || live.type !== 'terminal') {
        if (connectedId) {
          if (resolved.terminalType === 'local') {
            window.electronAPI.pty.dispose(connectedId).catch(() => {})
          } else {
            window.electronAPI.ssh.disconnect(connectedId).catch(() => {})
          }
        }
        return { success: false, error: 'pane or tab closed during connect' }
      }
      live.connectAttemptId = undefined
      live.isConnecting = false
      if (!connectedId) {
        if (created.cancelled) {
          // 取消后这一扇只是握手占位，收掉；别留成「已就绪」去挂一扇空终端
          await closePaneInternal(tab.id, live.id)
          return { success: false }
        }
        live.connectionError = lastSplitError || i18n.global.t('terminal.connectionFailed')
        return { success: false, error: live.connectionError }
      }
      if (live.ptyId !== connectedId) live.ptyId = connectedId
      live.connectionError = undefined
      if (live.isActive) {
        tab.ptyId = live.ptyId
        tab.isConnected = true
      }
      return { success: true }
    })()

    if (lookupPtyId) {
      inFlightReconnectByPtyId.set(lookupPtyId, run)
    }
    try {
      const result = await run
      const live = tab.splitLayout ? findPaneById(tab.splitLayout, paneId) : null
      // 连不上也把占位 id 留下，好让这一扇继续显示失败原因
      return result.success
        ? (live?.ptyId ?? lookupPtyId ?? null)
        : (live?.ptyId ?? null)
    } finally {
      if (lookupPtyId) inFlightReconnectByPtyId.delete(lookupPtyId)
    }
  }

  /**
   * 按已解析的 target 创建一个新终端实例（PTY 或 SSH）
   */
  async function createTerminalInstanceForTarget(
    resolved: {
      terminalType: 'local' | 'ssh'
      sshSessionId?: string
    },
    options?: { reuseId?: string; attemptId?: string }
  ): Promise<{ id: string | null; cancelled: boolean }> {
    const configStore = useConfigStore()
    try {
      if (resolved.terminalType === 'local') {
        const localEncoding = configStore.terminalSettings.localEncoding || 'auto'
        const created = await window.electronAPI.pty.create({
          cols: 80,
          rows: 24,
          encoding: localEncoding
        })
        return { id: created.id, cancelled: false }
      }

      if (!resolved.sshSessionId) {
        lastSplitError = 'ssh target missing sessionId'
        return { id: null, cancelled: false }
      }
      const session = configStore.sshSessions.find(s => s.id === resolved.sshSessionId)
      if (!session) {
        lastSplitError = `SSH session not found: ${resolved.sshSessionId}`
        log.error('SSH session not found:', resolved.sshSessionId)
        return { id: null, cancelled: false }
      }

      const jumpHost = configStore.getEffectiveJumpHost(session)

      const id = await window.electronAPI.ssh.connect({
        host: session.host,
        port: session.port,
        username: session.username,
        password: session.password,
        privateKeyPath: session.privateKeyPath,
        passphrase: session.passphrase,
        jumpHost: jumpHost ? toRaw(jumpHost) : undefined,
        encoding: session.encoding || 'utf-8',
        cols: 80,
        rows: 24
      }, {
        reuseId: options?.reuseId,
        attemptId: options?.attemptId
      })
      return { id, cancelled: false }
    } catch (error) {
      const parsed = recordConnectFailure(error)
      log.error('Failed to create terminal instance:', error)
      return { id: null, cancelled: parsed.cancelled }
    }
  }

  /**
   * 更新所有窗格的标签
   * 标签语义化为可翻译字符串；切换语言后下次分屏操作会刷新
   *
   * 单子节点的 split 容器（典型例子：ensureRootSplitLayoutForTab 初始化的根
   * split 在尚未真正分屏前只有 1 个 terminal child）不加方向前缀，否则单窗格
   * 会被错标成"左侧"——视觉上既没有"右侧"对照、又让 Agent 误以为已分屏。
   * 跳过这层后，唯一子节点继承父节点的 path，最终落到 `label.main`（"主窗格"）。
   *
   * 多层嵌套场景（如根 horizontal 含 1 个 vertical 子，vertical 又有 2 个终端）
   * 也会因此跳过最外层的"左侧"前缀，标签直接呈现为"上方"/"下方"，避免
   * 出现误导性的"左侧-上方"。
   */
  function panePositionLabel(
    direction: 'horizontal' | 'vertical' | undefined,
    index: number,
    count: number,
    t: (key: string, params?: Record<string, unknown>) => string
  ): string {
    const horizontal = direction === 'horizontal'
    if (count === 2) {
      if (horizontal) return index === 0 ? t('terminal.split.position.left') : t('terminal.split.position.right')
      return index === 0 ? t('terminal.split.position.top') : t('terminal.split.position.bottom')
    }
    if (count === 3) {
      if (index === 1) return t('terminal.split.position.middle')
      if (horizontal) return index === 0 ? t('terminal.split.position.left') : t('terminal.split.position.right')
      return index === 0 ? t('terminal.split.position.top') : t('terminal.split.position.bottom')
    }
    return horizontal
      ? t('terminal.split.position.col', { n: index + 1 })
      : t('terminal.split.position.row', { n: index + 1 })
  }

  function updatePaneLabels(layout: SplitPane, path: string = ''): void {
    const t = i18n.global.t
    if (layout.type === 'terminal') {
      layout.label = path || t('terminal.split.label.main')
      return
    }

    if (!layout.children || layout.children.length === 0) return

    if (layout.children.length === 1) {
      updatePaneLabels(layout.children[0], path)
      return
    }

    const count = layout.children.length
    layout.children.forEach((child, index) => {
      const position = panePositionLabel(layout.direction, index, count, t)
      const newPath = path ? `${path}-${position}` : position
      updatePaneLabels(child, newPath)
    })
  }

  /**
   * 关闭分屏窗格。
   *
   * `paneId` 接受两种值——优先按布局节点 id 查找；找不到时按 ptyId 查找。
   * 这样 Agent 可以传 list_panes 返回的 paneId 或 ptyId 任一种来关闭窗格，
   * 即使持有的 paneId 因某些边缘场景过期，也能用稳定的 ptyId 兜底。
   *
   * 返回 true 表示成功移除，false 表示找不到对应节点。
   * 如果只剩一个窗格，则关闭整个 tab。
   */
  async function closePaneInternal(tabId: string, paneId: string): Promise<boolean> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout) return false

    assertTabLayoutInvariant(tab)

    let pane = findPaneById(tab.splitLayout, paneId)
    if (!pane) {
      // 兼容路径：传入的可能是 ptyId 而非 paneId
      pane = getAllTerminalPanes(tab.splitLayout).find(p => p.ptyId === paneId) ?? null
    }
    if (!pane) return false

    // 连接收尾不阻塞关窗：主进程若在 SSH 优雅断开里卡住，这里一 await，
    // 助手的 manage_pane 就回不来，窗口也会假死。先拆布局，连路后台收。
    if (pane.connectAttemptId) {
      cancelSshHandshake(pane.connectAttemptId)
      pane.connectAttemptId = undefined
    }
    if (pane.ptyId) {
      const disposePtyId = pane.ptyId
      cancelPaneReconnectHandshake(disposePtyId)
      const disposePromise = pane.terminalType === 'local'
        ? window.electronAPI.pty.dispose(disposePtyId)
        : window.electronAPI.ssh.disconnect(disposePtyId)
      void disposePromise.catch((e: unknown) => {
        log.error('Failed to dispose pane terminal (layout already closed):', e)
      })
    }

    // 从布局中移除窗格
    const allPanes = getAllTerminalPanes(tab.splitLayout)

    // 关掉最后一个窗格：终端页 = 关页散场；助手页 = 拆管子、滑回对话台，人不走
    if (allPanes.length <= 1) {
      if (tab.type === 'assistant') {
        log.info(`Last hosted terminal closed on assistant tab=${tabId}, sliding back`)
        tab.ptyId = undefined
        tab.splitLayout = undefined
        tab.sshConfig = undefined
        tab.sshSessionId = undefined
        tab.systemInfo = undefined
        tab.isConnected = false
        return true
      }
      log.debug('Last pane closed, closing tab')
      await closeTab(tabId)
      return true
    }

    // 移除指定窗格（用 pane.id 而非入参 paneId——后者可能是 ptyId 兜底匹配进来的）；
    // 嵌套 split 容器在只剩 1 child 时由 removePaneFromLayout 自动 lift
    removePaneFromLayout(tab.splitLayout, pane.id)
    updatePaneLabels(tab.splitLayout)

    // 同步 root 终端身份字段（用激活窗格 / 第一个窗格）
    const remainingPanes = getAllTerminalPanes(tab.splitLayout)
    const fallbackPane = remainingPanes.find(p => p.isActive) || remainingPanes[0]
    if (fallbackPane?.ptyId) {
      tab.ptyId = fallbackPane.ptyId
      if (tab.type !== 'assistant') {
        if (fallbackPane.terminalType) {
          tab.type = fallbackPane.terminalType
        }
        if (fallbackPane.terminalType === 'ssh') {
          tab.sshConfig = fallbackPane.sshConfig
          tab.sshSessionId = fallbackPane.sshSessionId
        } else {
          tab.sshConfig = undefined
          tab.sshSessionId = undefined
        }
      } else if (fallbackPane.terminalType === 'ssh') {
        tab.sshConfig = fallbackPane.sshConfig
        tab.sshSessionId = fallbackPane.sshSessionId
      } else {
        tab.sshConfig = undefined
        tab.sshSessionId = undefined
      }
    }

    // 维护不变量：splitLayout 永远至少有一个激活窗格。
    // 关掉激活窗格时（pane.isActive === true）需要转移激活权；
    // 关掉非激活窗格但 lift 路径让原激活节点的 isActive 字段被冲掉、
    // 或被关闭的本身是 split 容器（没有 isActive 字段）等场景下，
    // 剩余 panes 也可能全部 inactive——此时同样要补一个激活，
    // 否则 getActivePtyId 找不到激活窗格会让 Agent 报"无法获取终端上下文"。
    const hasAnyActive = remainingPanes.some(p => p.isActive)
    if (!hasAnyActive && fallbackPane) {
      setActivePaneInTab(tabId, fallbackPane.id)
    }

    return true
  }

  /**
   * 设置激活的窗格。
   *
   * `paneId` 优先按布局节点 id 查找；找不到时按 ptyId 兜底——跟 closePane 行为一致，
   * Agent 拿到的 pane 标识符可以是 paneId 或 ptyId 任一种。
   *
   * 返回 true 表示成功激活，false 表示找不到目标节点（此时不修改任何状态，
   * 避免把所有窗格都清成 inactive 破坏"至少一个激活"不变量）。
   */
  function setActivePaneInTab(tabId: string, paneId: string): boolean {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout) return false

    let targetPane = findPaneById(tab.splitLayout, paneId)
    if (!targetPane) {
      targetPane = getAllTerminalPanes(tab.splitLayout).find(p => p.ptyId === paneId) ?? null
    }
    if (!targetPane) return false

    const allPanes = getAllTerminalPanes(tab.splitLayout)
    allPanes.forEach(p => p.isActive = false)
    targetPane.isActive = true
    return true
  }

  /**
   * 更新窗格大小
   */
  function updatePaneSize(tabId: string, paneId: string, size: number): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout) return

    const pane = findPaneById(tab.splitLayout, paneId)
    if (pane) {
      pane.size = Math.max(10, Math.min(90, size)) // 限制在 10-90% 之间
    }
  }

  /**
   * 重新排序标签页（用于拖拽）
   */
  function reorderTabs(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= tabs.value.length) return
    if (toIndex < 0 || toIndex >= tabs.value.length) return

    const [movedTab] = tabs.value.splice(fromIndex, 1)
    tabs.value.splice(toIndex, 0, movedTab)
  }

  // ==================== AI 消息管理 ====================

  /**
   * 获取当前终端的 AI 消息
   */
  function getAiMessages(tabId: string): AiMessage[] {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.aiMessages || []
  }

  /**
   * 添加 AI 消息
   */
  function addAiMessage(tabId: string, message: AiMessage): number {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return -1
    
    if (!tab.aiMessages) {
      tab.aiMessages = []
    }
    tab.aiMessages.push(message)
    return tab.aiMessages.length - 1
  }

  /**
   * 更新 AI 消息内容
   */
  function updateAiMessage(tabId: string, index: number, content: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab?.aiMessages && tab.aiMessages[index]) {
      tab.aiMessages[index].content = content
    }
  }

  /**
   * 清空 AI 消息
   */
  function clearAiMessages(tabId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiMessages = []
    }
  }

  /**
   * 设置 AI 加载状态
   */
  function setAiLoading(tabId: string, loading: boolean): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiLoading = loading
    }
  }

  /**
   * 设置 AI 对话滚动位置状态
   */
  function setAiScrollNearBottom(tabId: string, nearBottom: boolean): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiScrollNearBottom = nearBottom
    }
  }

  /**
   * 获取 AI 对话滚动位置状态
   */
  function getAiScrollNearBottom(tabId: string): boolean {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.aiScrollNearBottom ?? true  // 默认为 true
  }

  /**
   * 设置 AI 对话滚动位置
   */
  function setAiScrollTop(tabId: string, scrollTop: number): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiScrollTop = scrollTop
    }
  }

  /**
   * 获取 AI 对话滚动位置
   */
  function getAiScrollTop(tabId: string): number | undefined {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.aiScrollTop
  }

  function setAiScrollRatio(tabId: string, ratio: number): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiScrollRatio = ratio
    }
  }

  function getAiScrollRatio(tabId: string): number | undefined {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.aiScrollRatio
  }



  function setAiScrollAnchor(tabId: string, anchor: { id: string; offset: number }): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiScrollAnchor = anchor
    }
  }

  function getAiScrollAnchor(tabId: string): { id: string; offset: number } | undefined {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.aiScrollAnchor
  }

  /**
   * 请求终端获得焦点
   */
  function focusTerminal(tabId?: string): void {
    pendingFocusTabId.value = tabId || activeTabId.value
  }

  /**
   * 清除焦点请求
   */
  function clearPendingFocus(): void {
    pendingFocusTabId.value = ''
  }

  // ==================== Agent 状态管理 ====================

  /**
   * 根据 agentId 查找对应的终端 ID
   */
  function findTabIdByAgentId(agentId: string): string | undefined {
    const byTabAgentId = tabs.value.find(t => t.agentId === agentId)
    if (byTabAgentId) return byTabAgentId.id
    // 终端 tab 事件可能携带后端 run.id（存在 agentState.agentId）
    const byState = tabs.value.find(t => t.agentState?.agentId === agentId)
    return byState?.id
  }

  /**
   * 根据 ptyId 查找对应的终端 ID
   * 用于 Agent 事件匹配（比 agentId 更可靠，因为 ptyId 在启动前就已知）
   *
   * 兼容三种输入：
   *   1. tab.id（agentKey 重构后 IPC 回调 ptyId 字段携带的就是 tabId）
   *   2. tab.ptyId（兼容历史调用方）
   *   3. splitLayout 中任一窗格的 ptyId（分屏后非激活窗格也能匹配回 tab）
   */
  function findTabIdByPtyId(ptyId: string): string | undefined {
    for (const tab of tabs.value) {
      if (tab.id === ptyId) return tab.id
      if (tab.ptyId === ptyId) return tab.id
      if (tab.splitLayout) {
        const panes = getAllTerminalPanes(tab.splitLayout)
        if (panes.some(p => p.ptyId === ptyId)) return tab.id
      }
    }
    return undefined
  }

  /**
   * 获取当前终端的 Agent 状态
   */
  function getAgentState(tabId: string): AgentState | undefined {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.agentState
  }

  /**
   * 当前正在运行（前端发起）的 Agent 数量（排除远程 Watch/IM 后端直驱的会话）。
   */
  const runningAgentCount = computed(() =>
    tabs.value.filter(t => t.agentState?.isRunning && !t.isRemote).length
  )

  /** 前端发起的并发 Agent 软上限（主要防 Watch/定时批量涌入） */
  const MAX_CONCURRENT_AGENTS = 8

  /** 是否已达并发软上限 */
  const isAtConcurrencyLimit = computed(() => runningAgentCount.value >= MAX_CONCURRENT_AGENTS)

  /**
   * 设置 Agent 运行状态
   */
  function setAgentRunning(tabId: string, isRunning: boolean, agentId?: string, userTask?: string): void {
    log.debug('setAgentRunning called:', { tabId, isRunning, agentId })
    const tabIndex = tabs.value.findIndex(t => t.id === tabId)
    if (tabIndex === -1) {
      log.warn('setAgentRunning: tab not found for tabId:', tabId)
      return
    }

    const tab = tabs.value[tabIndex]

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: []
      }
    }

    // 创建新的 agentState 对象以确保响应式更新
    // 用户开始运行新任务时清除 loadedFromHistory：initializeRun 会触发 restoreFromHistory，
    // 把会话 in-memory 状态从 HistoryService 装回 Agent 实例，之后 fork 就能正常工作
    tab.agentState = {
      ...tab.agentState,
      isRunning,
      ...(agentId !== undefined && { agentId }),
      // 会话标题只在首次任务时写入，与 HistoryService 的 record.userTask（首条 user_task）保持一致
      ...(userTask !== undefined && !tab.agentState.userTask && { userTask }),
      ...(!isRunning && { pendingConfirm: undefined }),
      ...(isRunning && { loadedFromHistory: false, agentCompletedUnseen: false })
    }

    // 强制触发数组更新
    tabs.value = [...tabs.value]
    log.debug('setAgentRunning completed, new isRunning:', tab.agentState.isRunning)
  }

  /**
   * 设置 Agent 会话 ID 和开始时间（用于会话级保存）
   */
  function setAgentSession(tabId: string, sessionId: string, sessionStartTime: number): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: []
      }
    }

    tab.agentState = {
      ...tab.agentState,
      sessionId,
      sessionStartTime
    }

    releaseConversationFromOtherTabs(tabId, sessionId)
  }

  /**
   * 一条会话同一时刻只归属一个 tab。
   *
   * 会话漫游（在助手区回看过，之后换一个终端接着往下聊）会留下两个记着同一 sessionId 的
   * tab，侧栏点击就可能落到那份不干活的回看副本上——终端那边在跑甚至在等确认，人却被送进
   * 一个静止的页面。谁接着往下跑，会话就归谁，旧的回看副本让位。
   *
   * 只收只读副本：正在跑 / 等确认的一方不动（真出现两处都在跑，留着让问题暴露，别静默杀掉）。
   */
  function releaseConversationFromOtherTabs(ownerTabId: string, sessionId: string): void {
    const strays = tabs.value.filter(t =>
      t.id !== ownerTabId &&
      t.agentState?.sessionId === sessionId &&
      t.type === 'assistant' &&
      !t.isRemote &&
      t.agentId !== COMPANION_TAB_AGENT_ID
    )

    for (const stray of strays) {
      const meta = deriveTabAgentUiMeta(stray.agentState)
      if (meta.isRunning || meta.needsAttention) {
        log.warn(`[conversation] session ${sessionId} 同时被 ${stray.id} 持有且未空闲，保留待查`)
        continue
      }
      if (stray.agentId) {
        window.electronAPI.agent.cleanup(stray.agentId).catch(() => {})
      }
      const idx = tabs.value.findIndex(t => t.id === stray.id)
      if (idx >= 0) tabs.value.splice(idx, 1)
      if (hubFocusedAssistantTabId.value === stray.id) {
        hubFocusedAssistantTabId.value = ''
      }
      log.debug(`[conversation] session ${sessionId} 归 ${ownerTabId}，回收副本 tab ${stray.id}`)
    }
  }

  /** 更新当前 tab 的会话侧栏标题（LLM 生成或用户重命名后同步 UI） */
  function setAgentSessionTitle(tabId: string, title: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    const trimmed = title.trim()
    if (!trimmed) return

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: []
      }
    }

    tab.agentState = {
      ...tab.agentState,
      title: trimmed
    }
    tabs.value = [...tabs.value]
  }

  /**
   * 只设置 Agent ID，不改变运行状态
   * 用于在接收步骤事件时关联 agentId 和 tabId
   */
  function setAgentId(tabId: string, agentId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: []
      }
    }

    // 只更新 agentId，不改变其他状态
    if (tab.agentState.agentId !== agentId) {
      tab.agentState = {
        ...tab.agentState,
        agentId
      }
      tabs.value = [...tabs.value]
    }
  }

  /**
   * 只移除被正式步骤接住的那些临时消息。不能把墙上其他临时消息一起清掉。
   */
  function removeOptimisticAgentSteps(tabId: string, stepIds: string[]): void {
    if (stepIds.length === 0) return
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState?.steps.length) return
    const drop = new Set(stepIds)
    const filtered = tab.agentState.steps.filter(s => !drop.has(s.id))
    if (filtered.length === tab.agentState.steps.length) return
    tab.agentState = { ...tab.agentState, steps: filtered }
    tabs.value = [...tabs.value]
  }

  /**
   * IPC 异常结束且后端未推送 user_task 时，只固化这一轮自己的临时任务（去掉前缀）。
   * 其他临时消息还在等自己的正式步骤，改编号会导致对不上、出现两条。
   */
  function commitOptimisticAgentSteps(tabId: string, stepId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState?.steps.length) return
    if (!stepId.startsWith('__optimistic_')) return
    let changed = false
    const steps = tab.agentState.steps.map(s => {
      if (s.id !== stepId) return s
      changed = true
      return { ...s, id: s.id.slice('__optimistic_'.length) }
    })
    if (!changed) return
    tab.agentState = { ...tab.agentState, steps }
    tabs.value = [...tabs.value]
  }

  /**
   * 添加或更新 Agent 执行步骤
   * 如果步骤 id 已存在，则更新；否则添加新步骤
   */
  function addAgentStep(tabId: string, step: AgentStep): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) {
      log.warn(`addAgentStep: tab not found, tabId=${tabId}, step.type=${step.type}`)
      return
    }

    if (!tab.agentState) {
      log.warn(`addAgentStep: 创建缺失的 agentState, tabId=${tabId}`)
      tab.agentState = {
        isRunning: false,
        steps: []
      }
    }

    // 查找是否存在相同 id 的步骤
    const existingIndex = tab.agentState.steps.findIndex(s => s.id === step.id)
    
    if (existingIndex >= 0) {
      // 更新现有步骤（用于流式输出）
      // 必须用不可变方式替换 steps 数组引用，原地 steps[i]=step 不会改变 agentState
      // 对象引用，导致 flattenedItems computed 不重算，ThinkingBlock 收不到新 reasoning。
      const newSteps = tab.agentState.steps.slice()
      newSteps[existingIndex] = step
      tab.agentState = { ...tab.agentState, steps: newSteps }
    } else {
      // 添加新步骤
      tab.agentState = {
        ...tab.agentState,
        steps: [...tab.agentState.steps, step],
      }
      // 对关键步骤类型打印日志（user_task 和 final_result 是分组依据）
      if (step.type === 'user_task' || step.type === 'final_result') {
        log.debug(`addAgentStep 新增关键步骤: tabId=${tabId}, type=${step.type}, totalSteps=${tab.agentState.steps.length}, isRemote=${tab.isRemote}`)
      }
    }
  }

  /**
   * 按 ID 移除指定的 Agent 执行步骤
   * 用于后端撤销临时占位步骤（如初始"正在准备..."）后同步前端状态
   */
  function removeAgentStep(tabId: string, stepId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState) return
    const index = tab.agentState.steps.findIndex(s => s.id === stepId)
    if (index !== -1) {
      tab.agentState.steps.splice(index, 1)
    }
  }

  /** 更新会话级上下文栏快照（与 step 解耦） */
  function setAgentContextBar(tabId: string, contextBar: AgentContextBar): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return
    if (!tab.agentState) {
      tab.agentState = { isRunning: false, steps: [], contextBar: { ...contextBar } }
    } else {
      tab.agentState = { ...tab.agentState, contextBar: { ...contextBar } }
    }
    tabs.value = [...tabs.value]
  }

  /**
   * 设置待确认的工具调用
   */
  function setAgentPendingConfirm(tabId: string, confirmation: PendingConfirmation | undefined): void {
    const tabIndex = tabs.value.findIndex(t => t.id === tabId)
    if (tabIndex === -1 || !tabs.value[tabIndex].agentState) return

    const tab = tabs.value[tabIndex]
    const steps = tab.agentState!.steps.map(s =>
      s.isStreaming ? { ...s, isStreaming: false } : s
    )

    tab.agentState = {
      ...tab.agentState!,
      steps,
      pendingConfirm: confirmation,
    }
    tabs.value = [...tabs.value]
  }

  function setAgentPendingSecureInput(
    tabId: string,
    request: (import('@shared/types').PendingSecureInput & { ptyId?: string }) | undefined
  ): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState) return
    tab.agentState.pendingSecureInput = request
  }

  /**
   * Agent run 结束后的 UI 状态收口（App 全局 complete/error 兜底调用）。
   * 清除 isRunning / 待确认 / 流式标记，避免 tab 与历史侧栏长期卡在「运行中/思考中」。
   */
  function finalizeAgentRunState(tabId: string): void {
    const tabIndex = tabs.value.findIndex(t => t.id === tabId)
    if (tabIndex === -1 || !tabs.value[tabIndex].agentState) return

    const tab = tabs.value[tabIndex]
    const steps = tab.agentState!.steps.map(s =>
      s.isStreaming ? { ...s, isStreaming: false } : s
    )

    tab.agentState = {
      ...tab.agentState!,
      isRunning: false,
      pendingConfirm: undefined,
      pendingSecureInput: undefined,
      steps,
    }
    tabs.value = [...tabs.value]

    // Agent 完成后将当前产出物清单写入历史记录，保证后续加载时直接恢复（不需要 replay）
    if (tab.type === 'assistant') {
      saveArtifactsToHistory(tabId)
    }
  }

  /**
   * 标签栏「需要注意」：任务在后台 tab 结束，引导用户切回查看。
   */
  function setAgentCompletedUnseen(tabId: string, unseen: boolean): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState) return
    tab.agentState = { ...tab.agentState, agentCompletedUnseen: unseen }
    tabs.value = [...tabs.value]
  }

  /**
   * 清空 Agent 当前任务状态（保留 UI 步骤和会话标识）
   */
  function clearAgentState(tabId: string, preserveSession: boolean = true): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.agentState = {
        isRunning: false,
        agentId: tab.agentState?.agentId,
        sessionId: preserveSession ? tab.agentState?.sessionId : undefined,
        sessionStartTime: preserveSession ? tab.agentState?.sessionStartTime : undefined,
        userTask: preserveSession ? tab.agentState?.userTask : undefined,
        title: preserveSession ? tab.agentState?.title : undefined,
        steps: preserveSession ? (tab.agentState?.steps || []) : [],
        contextBar: preserveSession ? tab.agentState?.contextBar : undefined,
      }
    }
  }

  /**
   * 设置 Agent 最终结果
   */
  function setAgentFinalResult(tabId: string, result: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState) return
    tab.agentState.finalResult = result
  }

  /**
   * 根据历史记录 ID 查找已打开的 tab（agentState.sessionId 与 record.id 对应）。
   *
   * 正常只会有一个持有者（见 releaseConversationFromOtherTabs）。万一还有残留副本，
   * 落点必须是真身：先认在跑 / 等确认的，再认终端，只读副本永远排最后。
   */
  function findTabByHistoryId(historyId: string): TerminalTab | undefined {
    const holders = tabs.value.filter(t => t.agentState?.sessionId === historyId)
    if (holders.length <= 1) return holders[0]
    const busy = holders.find(t => {
      const meta = deriveTabAgentUiMeta(t.agentState)
      return meta.isRunning || meta.needsAttention
    })
    return busy ?? holders.find(isLocalOrSshTab) ?? holders[0]
  }

  /**
   * 从 tabs.agentState 派生的 UI 状态索引（随 store 更新自动重算）。
   * TabBar、历史侧栏等只读此索引，不各自维护规则。
   */
  const tabAgentUiMetaByTabId = computed(() => {
    const map = new Map<string, TabAgentUiMeta>()
    for (const tab of tabs.value) {
      if (tab.agentState) {
        map.set(tab.id, deriveTabAgentUiMeta(tab.agentState))
      }
    }
    return map
  })

  const historyConversationMetaBySessionId = computed(() => {
    const map = new Map<string, HistoryConversationMeta>()
    for (const tab of tabs.value) {
      const sessionId = tab.agentState?.sessionId
      if (!sessionId || !tab.agentState) continue
      map.set(sessionId, toHistoryConversationMeta(deriveTabAgentUiMeta(tab.agentState)))
    }
    return map
  })

  function getTabAgentUiMeta(tabId: string): TabAgentUiMeta {
    return tabAgentUiMetaByTabId.value.get(tabId) ?? deriveTabAgentUiMeta(undefined)
  }

  /** 侧栏历史对话元信息（按 sessionId 查 tabAgentUiMeta 索引） */
  function getHistoryConversationMeta(historyId: string): HistoryConversationMeta {
    return historyConversationMetaBySessionId.value.get(historyId) ?? CLOSED_HISTORY_CONVERSATION_META
  }

  function getHistoryConversationStatus(historyId: string): HistoryConversationTabStatus {
    return getHistoryConversationMeta(historyId).status
  }

  /**
   * 将当前产出物清单持久化到对应的历史记录中。
   * 在 Agent 完成、用户关闭产出物等场景调用，确保下次加载历史时直接恢复（无需 replay）。
   */
  function saveArtifactsToHistory(tabId: string) {
    const tab = tabs.value.find(t => t.id === tabId)
    const sessionId = tab?.agentState?.sessionId
    if (!sessionId) return
    // Pinia store 返回的是 Vue Proxy 对象，IPC 结构化克隆无法处理 Proxy。
    // 用 JSON 往返剥离包装，得到可序列化的纯对象再发送。
    try {
      const raw = [...useAssistantArtifactStore().getArtifacts(tabId)]
      const artifacts = JSON.parse(JSON.stringify(raw))
      window.electronAPI?.history?.saveArtifacts?.(sessionId, artifacts)
    } catch (e) {
      log.warn(`saveArtifactsToHistory: 序列化失败，跳过持久化 tabId=${tabId}`, e)
    }
  }

  /**
   * 打开历史对话：已有 tab 则聚焦，否则新建 assistant tab 并恢复历史。
   * 分叉会话使用新的 sessionId，与源记录独立映射。
   */
  function openHistoryConversation(record: AgentRecord): string {
    const existing = findTabByHistoryId(record.id)
    if (existing) {
      // 终端 tab / 已提升独立 tab / 远程助手 → 激活该 tab；
      // 仅本地未提升的助手会话走 Hub 主区聚焦（不离开首页）
      const isHubAssistant =
        existing.type === 'assistant' && !existing.isPromoted && !existing.isRemote
      if (isHubAssistant) {
        focusHubConversation(existing.id)
      } else {
        setActiveTab(existing.id)
      }
      hydrateConversationSkills(existing.id, record)
      return existing.id
    }

    const tabId = createAssistantTab({ activate: false })
    markAssistantSkipOnboarding(tabId)
    const customTitle = record.title?.trim()
    if (customTitle) {
      renameTab(tabId, customTitle)
    }
    restoreAgentHistory(tabId, record)
    focusHubConversation(tabId)
    return tabId
  }

  /**
   * 静默预热历史对话：与 openHistoryConversation 同构（建 tab + 恢复），但不 focus。
   * 供空闲预热队列调用；点侧栏时走 findTabByHistoryId 热路径。
   * @returns tabId；已存在 / 超预算 / 不可预热时返回 null
   */
  function warmHistoryConversation(record: AgentRecord): string | null {
    if (findTabByHistoryId(record.id)) return null
    if (record.agentKey === COMPANION_TAB_AGENT_ID) return null
    // 终端会话不预热：预热只会建助手 tab，之后 findTabByHistoryId 反而先命中这个假 tab，
    // 把本该切回终端的点击劫持到助手区
    if (record.terminalType === 'local' || record.terminalType === 'ssh') return null
    if ((record.steps?.length ?? 0) > WARM_HISTORY_MAX_STEPS) return null

    const tabId = createAssistantTab({ activate: false })
    markAssistantSkipOnboarding(tabId)
    const customTitle = record.title?.trim()
    if (customTitle) {
      renameTab(tabId, customTitle)
    }
    restoreAgentHistory(tabId, record)

    const tab = tabs.value.find(t => t.id === tabId)
    // 预热未聚焦：lastFocusedAt 置 0，LRU 优先淘汰未使用的预热项，保住用户真点过的会话
    if (tab) tab.lastFocusedAt = 0

    evictHubSessionsIfNeeded(tabId)
    return tabId
  }

  /**
   * 恢复历史 Agent 对话（从历史记录加载）
   */
  function restoreAgentHistory(tabId: string, record: {
    id: string
    timestamp: number
    userTask: string
    title?: string
    steps: Array<{
      id: string
      type: string
      content: string
      images?: string[]
      echartsOption?: import('@shared/types').EChartsStepPayload
      attachments?: AttachmentInfo[]
      toolName?: string
      toolArgs?: Record<string, unknown>
      toolResult?: string
      riskLevel?: string
      timestamp: number
      webSearchResults?: import('@shared/types').WebSearchResultItem[]
      success?: boolean
      askingStatus?: AgentStep['askingStatus']
      subAgents?: import('@shared/types').SubAgentResult[]
      canvasData?: import('@shared/types').CanvasData
    }>
    finalResult?: string
    duration: number
    status: 'completed' | 'failed' | 'aborted'
    artifacts?: import('@shared/types').CanvasArtifact[]
    loadedSkills?: string[]
    userDismissedSkills?: string[]
  }): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    // 转换历史记录的 steps 为完整的 AgentStep 数组
    const convertedSteps = record.steps.map(s => ({
      id: s.id,
      type: s.type as AgentStep['type'],
      content: s.content,
      images: s.images,
      echartsOption: s.echartsOption,
      attachments: s.attachments,
      toolName: s.toolName,
      toolArgs: s.toolArgs,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel as RiskLevel | undefined,
      timestamp: s.timestamp,
      webSearchResults: s.webSearchResults,
      success: s.success,
      askingStatus: s.askingStatus,
      subAgents: s.subAgents,
      canvasData: s.canvasData
    }))
    
    // 兼容旧数据：确保有 user_task 和 final_result 步骤
    const hasUserTask = convertedSteps.some(s => s.type === 'user_task')
    const steps: AgentStep[] = [
      ...(!hasUserTask ? [{
        id: `user_task_${record.timestamp}`,
        type: 'user_task' as const,
        content: record.userTask,
        timestamp: record.timestamp
      }] : []),
      ...convertedSteps,
      ...(record.finalResult && !convertedSteps.some(s => s.type === 'final_result') ? [{
        id: `final_result_${record.timestamp}`,
        type: 'final_result' as const,
        content: record.finalResult,
        timestamp: record.timestamp + record.duration
      }] : [])
    ]

    // 设置 agentState：sessionId 传给后端后，后端从 HistoryService 自行加载 messages 和 TaskMemory
    // loadedFromHistory：标记当前 in-memory 状态来自历史；用户发起首次新任务后才会被清除
    tab.agentState = {
      isRunning: false,
      agentId: tab.agentId,
      sessionId: record.id,
      sessionStartTime: record.timestamp,
      userTask: record.userTask,
      ...(record.title?.trim() ? { title: record.title.trim() } : {}),
      steps: steps,
      contextBar: deriveContextBarFromSteps(steps),
      loadedFromHistory: true
    }
    // 从历史恢复视为新视图：清除已存滚动，由 AiPanel 滚到最新一条
    delete tab.aiScrollTop
    delete tab.aiScrollRatio
    delete tab.aiScrollAnchor
    // 确保从欢迎页首次打开历史时，AiPanel 能立即感知 steps 变化
    tabs.value = [...tabs.value]

    // 恢复 Artifact 产出物面板（仅助手 tab；desktop 宿主职责，非 AiPanel）
    // 优先从持久化清单 record.artifacts 直接恢复（无需 replay）；
    // 清单缺失时（老记录）退化为按 steps 重放，保持向后兼容。
    if (tab.type === 'assistant') {
      const artifactStore = useAssistantArtifactStore()
      if (record.artifacts?.length) {
        artifactStore.restoreFromArtifacts(tabId, record.artifacts)
      } else {
        artifactStore.hydrateFromSteps(tabId, steps)
      }
    }

    hydrateConversationSkills(tabId, record)
  }

  function hydrateConversationSkills(
    tabId: string,
    record: { loadedSkills?: string[]; userDismissedSkills?: string[] }
  ): void {
    // 联络关掉再开不带回上次的技能。这一趟里点上的留在内存里，不要用历史清单盖掉。
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab?.agentId === COMPANION_TAB_AGENT_ID) return
    void import('./conversation-skills').then(({ useConversationSkillsStore }) => {
      const skillsStore = useConversationSkillsStore()
      if (Array.isArray(record.loadedSkills)) {
        skillsStore.hydrateFromRecord(tabId, record.loadedSkills)
      }
      void skillsStore.hydrateBackend(tabId, record.loadedSkills, record.userDismissedSkills)
    })
  }

  /** 已有 tab 再点开时也要从记录画胶囊；侧栏常走聚焦、不再走整场恢复。 */
  function hydrateConversationSkillsFromSession(tabId: string, sessionId?: string): void {
    if (!sessionId) return
    void window.electronAPI.history.getAgentRecordById(sessionId).then((record) => {
      if (!record) return
      hydrateConversationSkills(tabId, record)
    })
  }

  /**
   * 获取 Agent 上下文（用于发送给后端）
   * 支持多屏感知：如果有分屏布局，返回所有窗格的信息
   * 返回纯 JavaScript 对象，确保可以通过 IPC 序列化
   *
   * 返回 discriminated union（mode='single'|'split'）以强制调用方分支处理
   */
  function getAgentContext(tabId: string): AgentTerminalContext | null {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return null

    assertTabLayoutInvariant(tab)

    if (tab.splitLayout) {
      const panes = getAllTerminalPanes(tab.splitLayout)
      const activePaneId = findActivePaneInLayout(tab.splitLayout)?.id

      const panesContext = panes
        .filter(pane => Boolean(pane.ptyId))
        .map(pane => {
          const screenService = screenServices.get(pane.ptyId || '')
          let terminalOutput: string[] = []
          if (screenService) {
            terminalOutput = screenService.getLastNLines(50)
          }
          const fallbackType = (pane.terminalType === 'ssh' ? 'ssh' : 'local') as 'local' | 'ssh'
          return {
            paneId: pane.id,
            ptyId: pane.ptyId as string,
            label: pane.label || 'Unknown',
            connectionName: getPaneConnectionName(pane),
            isActive: pane.id === activePaneId,
            terminalOutput,
            terminalType: fallbackType
          }
        })

      // 默认窗格（激活窗格优先；否则第一个窗格）作为兼容字段填充
      const defaultPane = panesContext.find(p => p.isActive) || panesContext[0]

      const result: AgentTerminalContextSplit = {
        mode: 'split',
        ptyId: defaultPane?.ptyId || '',
        terminalOutput: defaultPane?.terminalOutput || [],
        terminalType: defaultPane?.terminalType || tab.type,
        activePaneId,
        panes: panesContext,
        systemInfo: {
          os: tab.systemInfo?.os || 'unknown',
          shell: tab.systemInfo?.shell || 'unknown'
        }
      }
      return JSON.parse(JSON.stringify(result)) as AgentTerminalContextSplit
    }

    const screenService = screenServices.get(tab.ptyId || '')
    let terminalOutput: string[]
    if (screenService) {
      terminalOutput = screenService.getLastNLines(50)
    } else {
      terminalOutput = (tab.outputBuffer || []).slice(-50).map(line => stripAnsi(line))
    }

    const result: AgentTerminalContextSingle = {
      mode: 'single',
      ptyId: tab.ptyId || '',
      terminalOutput,
      systemInfo: {
        os: tab.systemInfo?.os || 'unknown',
        shell: tab.systemInfo?.shell || 'unknown'
      },
      terminalType: tab.type
    }
    return JSON.parse(JSON.stringify(result)) as AgentTerminalContextSingle
  }

  // ==================== 分屏 helpers（对外暴露，避免外部直接读 tab.ptyId/splitLayout）====================

  /**
   * 是否处于分屏模式
   */
  function isSplitTab(tab: TerminalTab): boolean {
    return Boolean(tab.splitLayout)
  }

  /**
   * 窗格此刻连着谁：远程取会话名（并带上地址便于用户按 IP 指认），本机为本地终端。
   *
   * 每次按当前连接现取，不缓存到窗格上——SSH 重连 / 换会话后名字要跟着变，
   * 否则界面和 Agent 都会拿着过期的机器身份说话。窗格标签、换台标题、Agent
   * 上下文共用这一份，保证用户说"右边那台"时双方对的是同一个名字。
   */
  function getPaneConnectionName(pane: {
    terminalType?: string
    sshSessionId?: string
    sshConfig?: { host: string; username: string }
  }): string {
    const t = i18n.global.t
    if (pane.terminalType !== 'ssh') return t('terminal.localTerminal')

    const session = pane.sshSessionId
      ? useConfigStore().sshSessions.find(s => s.id === pane.sshSessionId)
      : undefined
    // 有已保存会话时以会话为准：重连按会话当前的地址连，窗格上那份只是首次连接时的快照，
    // 用户改过会话地址后它就过期了（正是"名字要跟着当前连接走"要避免的情况）
    const host = session?.host || pane.sshConfig?.host
    const username = session?.username || pane.sshConfig?.username
    const address = host && username ? `${username}@${host}` : ''
    const name = session?.name?.trim()

    if (!name) return address || t('tabs.sshTerminal')
    // 会话名本身就是地址时不重复一遍
    if (!address || (host && name.includes(host))) return name
    return `${name} (${address})`
  }

  /**
   * 获取激活窗格（或单屏）的 ptyId
   * 分屏模式：返回当前激活窗格的 ptyId
   * 单屏模式：返回 tab.ptyId
   */
  function getActivePtyId(tab: TerminalTab): string | undefined {
    if (tab.splitLayout) {
      // 找不到激活窗格时退回到第一个终端窗格——跟 getAgentContext 的兜底保持一致，
      // 避免某些边缘场景（如关闭后 isActive 状态丢失）让上层误判为"没有可用终端"。
      return findActivePaneInLayout(tab.splitLayout)?.ptyId
        ?? getAllTerminalPanes(tab.splitLayout)[0]?.ptyId
    }
    return tab.ptyId
  }

  /**
   * 获取 tab 内所有 ptyId（单屏返回单个，分屏返回所有窗格）
   */
  function getAllTabPtyIds(tab: TerminalTab): string[] {
    if (tab.splitLayout) {
      return getAllTerminalPanes(tab.splitLayout)
        .map(p => p.ptyId)
        .filter((id): id is string => Boolean(id))
    }
    return tab.ptyId ? [tab.ptyId] : []
  }

  /** 当前 tab 内可用于批量命令的窗格数量（>1 视为已分屏） */
  function getBatchPaneCount(tab: TerminalTab): number {
    if (tab.type === 'assistant') return 0
    if (tab.splitLayout) {
      return getAllTerminalPanes(tab.splitLayout).filter(p => Boolean(p.ptyId)).length
    }
    return tab.ptyId ? 1 : 0
  }

  function hasMultipleBatchPanes(tab: TerminalTab): boolean {
    return getBatchPaneCount(tab) > 1
  }

  function buildBatchTargetsFromTab(tab: TerminalTab): BatchCommandTarget[] {
    if (tab.type === 'assistant' || !tab.isConnected) return []

    const panes = tab.splitLayout
      ? getAllTerminalPanes(tab.splitLayout).filter(p => Boolean(p.ptyId))
      : []

    if (panes.length === 0) {
      if (!tab.ptyId) return []
      const terminalType = tab.type as 'local' | 'ssh'
      const hostHint = tab.sshConfig
        ? `${tab.sshConfig.username}@${tab.sshConfig.host}`
        : undefined
      return [{
        key: `${tab.id}:${tab.ptyId}`,
        tabId: tab.id,
        ptyId: tab.ptyId,
        terminalType,
        tabTitle: tab.title,
        hostHint,
        isConnected: tab.isConnected
      }]
    }

    return panes.map(pane => {
      const ptyId = pane.ptyId as string
      const terminalType = (pane.terminalType ?? tab.type) as 'local' | 'ssh'
      const hostHint = pane.sshConfig
        ? `${pane.sshConfig.username}@${pane.sshConfig.host}`
        : tab.sshConfig && terminalType === 'ssh'
          ? `${tab.sshConfig.username}@${tab.sshConfig.host}`
          : undefined
      return {
        key: `${tab.id}:${ptyId}`,
        tabId: tab.id,
        ptyId,
        terminalType,
        tabTitle: tab.title,
        paneLabel: pane.label,
        hostHint,
        isConnected: tab.isConnected
      }
    })
  }

  function getAllBatchTargets(): BatchCommandTarget[] {
    return tabs.value.flatMap(buildBatchTargetsFromTab)
  }

  function getBatchTargetsForTab(tabId: string): BatchCommandTarget[] {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab ? buildBatchTargetsFromTab(tab) : []
  }

  /**
   * 打开批量面板时的默认范围：当前 tab 已分屏 → 本 tab；否则 → 全部 tab
   */
  function getDefaultBatchScope(): { scope: BatchCommandScope; tabId?: string } {
    const tab = activeTab.value
    if (tab && tab.type !== 'assistant' && hasMultipleBatchPanes(tab)) {
      return { scope: 'tab', tabId: tab.id }
    }
    return { scope: 'all' }
  }

  /**
   * 校验 tab.ptyId 与 tab.splitLayout 的不变量
   *
   * 设计：终端类型 tab 一旦持有 ptyId，就**始终**有一个 root split 容器作为 splitLayout，
   * 单屏时 children 仅含 1 个 terminal 节点，分屏时 ≥2 个。这样 SplitPaneView 始终是
   * 终端的渲染入口，从单屏到分屏只是给 root 容器添加兄弟节点，原 terminal 节点 id 稳定，
   * Vue 通过 :key 复用组件实例 → xterm 内容自然保留。
   *
   * 违反时仅记录日志，不抛异常，避免阻塞用户操作；便于排查状态机 bug。
   */
  function assertTabLayoutInvariant(tab: TerminalTab): void {
    if (tab.type === 'assistant' && !tab.splitLayout) return
    if (tab.ptyId && !tab.splitLayout) {
      log.error(
        `[invariant] Tab ${tab.id} has ptyId (${tab.ptyId}) but no splitLayout — should have been initialized`
      )
    }
    if (tab.splitLayout && tab.splitLayout.type !== 'split') {
      log.error(
        `[invariant] Tab ${tab.id} root splitLayout must be a split container, got ${tab.splitLayout.type}`
      )
    }
    // 全局唯一性：同一 tab 的 splitLayout 树里不能出现重复 ptyId / 重复 paneId。
    // 若违反，常见后果是 Agent 按 ptyId 路由命令时进了错的窗格，前端 SplitPaneView
    // 也会出现两个 :key 相同的 Terminal 实例渲染冲突。
    if (tab.splitLayout) {
      const allPanes = getAllTerminalPanes(tab.splitLayout)
      const ptyCount = new Map<string, number>()
      const paneCount = new Map<string, number>()
      for (const p of allPanes) {
        if (p.ptyId) ptyCount.set(p.ptyId, (ptyCount.get(p.ptyId) || 0) + 1)
        if (p.id) paneCount.set(p.id, (paneCount.get(p.id) || 0) + 1)
      }
      for (const [ptyId, n] of ptyCount) {
        if (n > 1) {
          log.error(
            `[invariant] Tab ${tab.id} has DUPLICATE ptyId=${ptyId} (count=${n}) — Agent commands will route to the wrong pane!`,
            { layout: JSON.parse(JSON.stringify(tab.splitLayout)) }
          )
        }
      }
      for (const [paneId, n] of paneCount) {
        if (n > 1) {
          log.error(
            `[invariant] Tab ${tab.id} has DUPLICATE paneId=${paneId} (count=${n})`,
            { layout: JSON.parse(JSON.stringify(tab.splitLayout)) }
          )
        }
      }
    }
  }

  /**
   * 为 tab 初始化 root splitLayout（终端类型 tab，已分配 ptyId 后调用）
   *
   * 单屏 layout = split 容器 + 1 个 terminal 子节点。子节点 id 在此处分配并保持稳定，
   * 之后无论分屏/关窗格，原 terminal 子节点 id 都不变（除非该窗格被关闭），
   * 保证 SplitPaneView v-for 的 :key 稳定，原 Terminal 组件实例不重建。
   *
   * 已有 splitLayout 时本函数 no-op，避免覆盖。
   */
  function ensureRootSplitLayoutForTab(
    tab: TerminalTab,
    paneTerminalType?: 'local' | 'ssh'
  ): void {
    if (!tab.ptyId) return
    if (tab.splitLayout) return
    const leafType: 'local' | 'ssh' | undefined = paneTerminalType
      ?? (tab.type === 'ssh' ? 'ssh' : tab.type === 'local' ? 'local' : undefined)
    if (!leafType) return

    const t = i18n.global.t
    tab.splitLayout = {
      id: uuidv4(),
      type: 'split',
      direction: 'horizontal',
      children: [
        {
          id: uuidv4(),
          type: 'terminal',
          ptyId: tab.ptyId,
          terminalType: leafType,
          sshConfig: tab.sshConfig,
          sshSessionId: tab.sshSessionId,
          label: t('terminal.split.label.main'),
          isActive: true,
          size: 100
        }
      ]
    }
  }

  function tabHostsTerminal(tab: { splitLayout?: SplitPane; ptyId?: string }): boolean {
    if (tab.splitLayout) {
      return getAllTerminalPanes(tab.splitLayout).some(p => Boolean(p.ptyId))
    }
    return Boolean(tab.ptyId)
  }

  /**
   * 获取布局中的所有终端窗格
   */
  // ==================== 文档管理 ====================

  /**
   * 获取终端的上传文档
   */
  function getUploadedDocs(tabId: string): ParsedDocument[] {
    if (tabId === WELCOME_COMPOSER_TAB_ID) return welcomeComposerDocs.value
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.uploadedDocs || []
  }

  /**
   * 设置终端的上传文档（替换模式，不是追加）
   */
  function setUploadedDocs(tabId: string, docs: ParsedDocument[]): void {
    if (tabId === WELCOME_COMPOSER_TAB_ID) {
      welcomeComposerDocs.value = docs
      return
    }
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.uploadedDocs = docs
    }
  }

  /**
   * 添加文档到终端（追加到现有列表）
   */
  function addUploadedDocs(tabId: string, docs: ParsedDocument[]): void {
    if (tabId === WELCOME_COMPOSER_TAB_ID) {
      welcomeComposerDocs.value = [...welcomeComposerDocs.value, ...docs]
      return
    }
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      if (!tab.uploadedDocs) {
        tab.uploadedDocs = []
      }
      tab.uploadedDocs = [...tab.uploadedDocs, ...docs]
    }
  }

  /**
   * 移除终端的指定文档
   */
  function removeUploadedDoc(tabId: string, index: number): void {
    if (tabId === WELCOME_COMPOSER_TAB_ID) {
      welcomeComposerDocs.value.splice(index, 1)
      return
    }
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab?.uploadedDocs) {
      tab.uploadedDocs.splice(index, 1)
    }
  }

  /**
   * 清空终端的所有文档
   */
  function clearUploadedDocs(tabId: string): void {
    if (tabId === WELCOME_COMPOSER_TAB_ID) {
      welcomeComposerDocs.value = []
      return
    }
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.uploadedDocs = []
    }
  }

  /**
   * 将某 tab（或欢迎页暂存）的上传文档迁移到目标 tab
   */
  function transferUploadedDocs(fromTabId: string, toTabId: string): void {
    const docs = getUploadedDocs(fromTabId)
    if (docs.length === 0) return
    addUploadedDocs(toTabId, JSON.parse(JSON.stringify(docs)))
    clearUploadedDocs(fromTabId)
  }

  function getWelcomeComposerDraft(): { text: string; images: PendingImage[] } {
    return {
      text: welcomeComposerText.value,
      images: welcomeComposerImages.value.map(img => ({ ...img }))
    }
  }

  function setWelcomeComposerDraft(text: string, images: PendingImage[]): void {
    welcomeComposerText.value = text
    welcomeComposerImages.value = images.map(img => ({ ...img }))
  }

  function clearWelcomeComposerDraft(): void {
    welcomeComposerText.value = ''
    welcomeComposerImages.value = []
  }

  function setPendingComposerHandoff(tabId: string, handoff: PendingComposerHandoff): void {
    pendingComposerHandoffs.value[tabId] = handoff
  }

  function consumePendingComposerHandoff(tabId: string): PendingComposerHandoff | undefined {
    const handoff = pendingComposerHandoffs.value[tabId]
    if (handoff) {
      delete pendingComposerHandoffs.value[tabId]
    }
    return handoff
  }

  function markAssistantSkipOnboarding(tabId: string): void {
    assistantSkipOnboardingTabIds.value.add(tabId)
  }

  function consumeAssistantSkipOnboarding(tabId: string): boolean {
    if (!assistantSkipOnboardingTabIds.value.has(tabId)) return false
    assistantSkipOnboardingTabIds.value.delete(tabId)
    return true
  }

  // ==================== 屏幕服务管理 ====================

  /**
   * 注册屏幕服务实例
   * 由 Terminal.vue 组件在创建时调用
   * @param ptyId 终端实例 ID（改为使用 ptyId 而不是 tabId，以支持分屏）
   */
  function registerScreenService(ptyId: string, service: TerminalScreenService): void {
    screenServices.set(ptyId, service)
  }

  /**
   * 注销屏幕服务实例
   * 由 Terminal.vue 组件在销毁时调用
   * @param ptyId 终端实例 ID
   */
  function unregisterScreenService(ptyId: string): void {
    screenServices.delete(ptyId)
  }

  /**
   * 获取屏幕服务实例
   * @param ptyId 终端实例 ID
   */
  function getScreenService(ptyId: string): TerminalScreenService | undefined {
    return screenServices.get(ptyId)
  }

  /**
   * 获取终端屏幕内容
   * 比 getRecentOutput 更准确，直接从 xterm buffer 读取
   * @param ptyId 终端实例 ID
   */
  function getScreenContent(ptyId: string): ScreenContent | null {
    const service = screenServices.get(ptyId)
    if (!service) return null
    return service.getScreenContent()
  }

  /**
   * 获取终端最近 N 行（从屏幕服务获取，更准确）
   * @param ptyId 终端实例 ID
   */
  function getScreenLastNLines(ptyId: string, n: number): string[] {
    const service = screenServices.get(ptyId)
    if (!service) {
      // 降级到 outputBuffer（通过 ptyId 查找 tab）
      const tab = tabs.value.find(t => t.ptyId === ptyId)
      if (!tab?.outputBuffer) return []
      return tab.outputBuffer.slice(-n).map(line => stripAnsi(line))
    }
    return service.getLastNLines(n)
  }

  /**
   * 检测终端是否处于命令提示符状态
   * @param ptyId 终端实例 ID
   */
  function isTerminalAtPrompt(ptyId: string): boolean {
    const service = screenServices.get(ptyId)
    if (!service) return false
    return service.isAtPrompt()
  }

  /**
   * 获取终端光标位置
   * @param ptyId 终端实例 ID
   */
  function getCursorPosition(ptyId: string): { x: number; y: number } | null {
    const service = screenServices.get(ptyId)
    if (!service) return null
    return service.getCursorPosition()
  }

  /**
   * 检测终端屏幕中的错误信息
   * @param ptyId 终端实例 ID
   */
  function detectScreenErrors(ptyId: string, maxLines?: number): Array<{ line: number; content: string; type: string }> {
    const service = screenServices.get(ptyId)
    if (!service) return []
    return service.detectErrors(maxLines)
  }

  // ==================== 快照管理器管理 ====================

  /**
   * 注册快照管理器实例
   */
  function registerSnapshotManager(tabId: string, manager: TerminalSnapshotManager): void {
    snapshotManagers.set(tabId, manager)
  }

  /**
   * 注销快照管理器实例
   */
  function unregisterSnapshotManager(tabId: string): void {
    snapshotManagers.delete(tabId)
  }

  /**
   * 获取快照管理器实例
   */
  function getSnapshotManager(tabId: string): TerminalSnapshotManager | undefined {
    return snapshotManagers.get(tabId)
  }

  /**
   * 创建终端状态快照
   */
  function createSnapshot(tabId: string, name?: string): TerminalSnapshot | null {
    const manager = snapshotManagers.get(tabId)
    if (!manager) return null
    return manager.createSnapshot(name)
  }

  /**
   * 创建快照并与上一个比较
   */
  function snapshotAndCompare(tabId: string): { snapshot: TerminalSnapshot; diff: TerminalDiff | null } | null {
    const manager = snapshotManagers.get(tabId)
    if (!manager) return null
    return manager.snapshotAndCompare()
  }

  /**
   * 检查终端内容是否变化
   */
  function hasContentChanged(tabId: string): boolean {
    const manager = snapshotManagers.get(tabId)
    if (!manager) return true
    return manager.hasContentChanged()
  }

  /**
   * 获取自上次快照以来的新输出
   */
  function getNewOutputSinceLastSnapshot(tabId: string): string[] {
    const manager = snapshotManagers.get(tabId)
    if (!manager) return []
    return manager.getNewOutputSinceLastSnapshot()
  }

  /**
   * 更新快照管理器的外部状态
   */
  function updateSnapshotExternalState(tabId: string, state: {
    cwd?: string
    lastCommand?: string
    lastExitCode?: number
    isIdle?: boolean
  }): void {
    const manager = snapshotManagers.get(tabId)
    if (manager) {
      manager.updateExternalState(state)
    }
  }

  /**
   * 检查指定终端是否有待确认操作
   */
  function hasPendingConfirm(tabId: string): boolean {
    return getTabAgentUiMeta(tabId).pendingConfirm
  }

  function hasAgentCompletedUnseen(tabId: string): boolean {
    return getTabAgentUiMeta(tabId).agentCompletedUnseen
  }

  /** 标签栏 needs-attention：待确认 或 后台任务刚结束 */
  function hasTabAgentAttention(tabId: string): boolean {
    return getTabAgentUiMeta(tabId).needsAttention
  }

  /** Hub 任务区入口：用户在其他 Tab / 待办面时，汇总侧栏会话的 attention（完成/待确认） */
  const hasTasksAreaAttention = computed(() =>
    hasHubTasksAreaAttention(tabs.value, activeTabId.value, COMPANION_TAB_AGENT_ID, todosActive.value)
  )

  const hasTerminalPlaceAttention = computed(() =>
    terminalTabs.value.some(t => t.id !== activeTabId.value && hasTabAgentAttention(t.id))
  )

  const hasCompanionAttention = computed(() => {
    const companion = tabs.value.find(t => t.agentId === COMPANION_TAB_AGENT_ID)
    if (!companion || companion.id === activeTabId.value) return false
    return hasTabAgentAttention(companion.id)
  })

  // Proactive 消息延迟投递：agent 忙时暂存，完成后再注入 tab
  const deferredProactiveTabs = ref(new Set<string>())

  /**
   * `agent:complete` 在 App 中用 microtask 兜底点亮 tab 前，
   * useAgentMode 若将立即自动起新 run（队列 proactive / pending 用户消息），先 request，consume 后跳过点亮。
   */
  const agentCompleteTabAttentionSkipOnce = ref(new Set<string>())

  function requestAgentCompleteTabAttentionSkip(tabId: string): void {
    agentCompleteTabAttentionSkipOnce.value = new Set([...agentCompleteTabAttentionSkipOnce.value, tabId])
  }

  function consumeAgentCompleteTabAttentionSkip(tabId: string): boolean {
    if (!agentCompleteTabAttentionSkipOnce.value.has(tabId)) return false
    const next = new Set(agentCompleteTabAttentionSkipOnce.value)
    next.delete(tabId)
    agentCompleteTabAttentionSkipOnce.value = next
    return true
  }

  function markDeferredProactive(tabId: string): void {
    deferredProactiveTabs.value = new Set([...deferredProactiveTabs.value, tabId])
  }

  function hasDeferredProactive(tabId: string): boolean {
    return deferredProactiveTabs.value.has(tabId)
  }

  function clearDeferredProactive(tabId: string): void {
    if (!deferredProactiveTabs.value.has(tabId)) return
    const next = new Set(deferredProactiveTabs.value)
    next.delete(tabId)
    deferredProactiveTabs.value = next
  }

  /**
   * 确保「联络」常驻 tab 存在（agentId = __companion__, isRemote = true）。
   * 启动时调用；已存在则直接返回其 id，不重复创建，也不抢夺 activeTabId。
   */
  function ensureCompanionTab(): string {
    if (!isWorkbenchAvailable('companion')) {
      log.info('ensureCompanionTab skipped: companion feature disabled')
      return ''
    }
    const existing = tabs.value.find(t => t.agentId === COMPANION_TAB_AGENT_ID)
    if (existing) {
      existing.isRemote = true
      if (!existing.customTitle) {
        existing.title = i18n.global.t('tabs.reach', '联络')
      }
      return existing.id
    }
    const t = i18n.global.t
    const prevActive = activeTabId.value
    const id = createAssistantTab({
      agentId: COMPANION_TAB_AGENT_ID,
      title: t('tabs.reach', '联络'),
      isRemote: true,
      activate: false,
    })
    markAssistantSkipOnboarding(id)
    // createAssistantTab 在 isRemote && !activeTabId 时会自动激活，还原原值防止抢首页
    activeTabId.value = prevActive
    return id
  }

  return {
    tabs,
    activeTabId,
    todosActive,
    activeTab,
    tabCount,
    pendingFocusTabId,
    isSplitTab,
    getPaneConnectionName,
    getActivePtyId,
    getAllTabPtyIds,
    getBatchPaneCount,
    hasMultipleBatchPanes,
    getAllBatchTargets,
    getBatchTargetsForTab,
    getDefaultBatchScope,
    createTab,
    createAssistantTab,
    forkToAssistantTab,
    createTabWithExistingPty,
    createTabWithTask,
    pendingSchedulerTasks,
    consumePendingSchedulerTask,
    pendingComposerHandoffs,
    setPendingComposerHandoff,
    consumePendingComposerHandoff,
    markAssistantSkipOnboarding,
    consumeAssistantSkipOnboarding,
    transferUploadedDocs,
    getWelcomeComposerDraft,
    setWelcomeComposerDraft,
    clearWelcomeComposerDraft,
    closeTab,
    reconnectSsh,
    isPtyReconnecting,
    reconnectEpochByPtyId,
    setActiveTab,
    goToHome,
    focusTaskArea,
    focusTerminalPlace,
    focusCompanionPlace,
    shellPlace,
    terminalTabs,
    terminalPlaceActive,
    conversationSurface,
    restoreConversationSurface,
    openTodos,
    hubFocusedAssistantTabId,
    hubFocusedTab,
    focusHubConversation,
    clearHubFocus,
    promoteConversationToTab,
    runningAgentCount,
    isAtConcurrencyLimit,
    updateTabTitle,
    renameTab,
    updateConnectionStatus,
    updateSystemInfo,
    appendOutput,
    clearError,
    updateSelectedText,
    getRecentOutput,
    writeToTerminal,
    resizeTerminal,
    writeToPty,
    resizePty,
    splitTerminal,
    splitAtEdge,
    movePaneInTab,
    layoutDrag,
    beginLayoutDrag,
    endLayoutDrag,
    sshSplitAtEdgeRequest,
    requestSshSplitAtEdge,
    consumeSshSplitAtEdgeRequest,
    openTerminalOnTab,
    tabHostsTerminal,
    getLastSplitError,
    wasLastSplitCancelled,
    tabHasPaneConnectionError,
    closePane: closePaneInternal,
    setActivePaneInTab,
    updatePaneSize,
    reorderTabs,
    getAiMessages,
    addAiMessage,
    updateAiMessage,
    clearAiMessages,
    setAiLoading,
    setAiScrollNearBottom,
    getAiScrollNearBottom,
    setAiScrollTop,
    getAiScrollTop,
    setAiScrollRatio,
    getAiScrollRatio,
    setAiScrollAnchor,
    getAiScrollAnchor,
    focusTerminal,
    clearPendingFocus,
    assistantComposerFocusTabId,
    assistantComposerFocusSeq,
    requestAssistantComposerFocus,
    terminalAiPanelRevealTabId,
    terminalAiPanelRevealSeq,
    requestTerminalAiPanelReveal,
    // Agent 状态管理
    findTabIdByAgentId,
    findTabIdByPtyId,
    getAgentState,
    setAgentRunning,
    setAgentSession,
    setAgentSessionTitle,
    setAgentId,
    addAgentStep,
    removeOptimisticAgentSteps,
    commitOptimisticAgentSteps,
    removeAgentStep,
    setAgentContextBar,
    setAgentPendingConfirm,
    finalizeAgentRunState,
    setAgentPendingSecureInput,
    clearAgentState,
    setAgentFinalResult,
    restoreAgentHistory,
    findTabByHistoryId,
    tabAgentUiMetaByTabId,
    historyConversationMetaBySessionId,
    getTabAgentUiMeta,
    getHistoryConversationMeta,
    getHistoryConversationStatus,
    openHistoryConversation,
    warmHistoryConversation,
    hydrateConversationSkills,
    hydrateConversationSkillsFromSession,
    saveArtifactsToHistory,
    getAgentContext,
    // 文档管理
    getUploadedDocs,
    setUploadedDocs,
    addUploadedDocs,
    removeUploadedDoc,
    clearUploadedDocs,
    // 屏幕服务管理
    registerScreenService,
    unregisterScreenService,
    getScreenService,
    getScreenContent,
    getScreenLastNLines,
    isTerminalAtPrompt,
    getCursorPosition,
    detectScreenErrors,
    // 快照管理器管理
    registerSnapshotManager,
    unregisterSnapshotManager,
    getSnapshotManager,
    createSnapshot,
    snapshotAndCompare,
    hasContentChanged,
    getNewOutputSinceLastSnapshot,
    updateSnapshotExternalState,
    hasPendingConfirm,
    hasAgentCompletedUnseen,
    hasTabAgentAttention,
    hasTasksAreaAttention,
    hasTerminalPlaceAttention,
    hasCompanionAttention,
    setAgentCompletedUnseen,
    // Proactive 消息延迟投递
    markDeferredProactive,
    hasDeferredProactive,
    clearDeferredProactive,
    ensureCompanionTab,
    requestAgentCompleteTabAttentionSkip,
    consumeAgentCompleteTabAttentionSkip
  }
})

