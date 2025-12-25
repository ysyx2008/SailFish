import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import stripAnsiLib from 'strip-ansi'
import i18n from '../i18n'
import type { JumpHostConfig } from './config'
import { useConfigStore } from './config'
import type { TerminalScreenService, ScreenContent } from '../services/terminal-screen.service'
import type { TerminalSnapshotManager, TerminalSnapshot, TerminalDiff } from '../services/terminal-snapshot.service'

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

// Agent 相关类型
export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

// 计划步骤进度
export interface PlanStepProgress {
  value: number
  current?: number
  total?: number
  eta?: string
  speed?: string
  isIndeterminate: boolean
  statusText?: string
}

// 计划步骤
export interface AgentPlanStep {
  id: string
  title: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  result?: string
  progress?: PlanStepProgress
}

// Agent 执行计划
export interface AgentPlan {
  id: string
  title: string
  steps: AgentPlanStep[]
  createdAt: number
  updatedAt: number
}

export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'user_task' | 'final_result' | 'user_supplement' | 'waiting' | 'asking' | 'waiting_password' | 'plan_created' | 'plan_updated' | 'plan_archived'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean
  plan?: AgentPlan  // 计划数据（仅 plan_created/plan_updated 类型使用）
}

export interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
}

// Agent 历史任务记录（完整保存执行过程）
export interface AgentHistoryItem {
  userTask: string        // 用户任务描述
  steps: AgentStep[]      // 完整的执行步骤
  finalResult: string     // Agent 完成后的回复
  timestamp: number       // 时间戳
}

export interface AgentState {
  isRunning: boolean
  agentId?: string
  userTask?: string      // 用户任务描述
  steps: AgentStep[]
  pendingConfirm?: PendingConfirmation
  finalResult?: string   // Agent 完成后的最终回复
  history: AgentHistoryItem[]  // 历史任务记录
}

// 上传的文档类型
export interface ParsedDocument {
  filename: string
  fileType: string
  content: string
  fileSize: number
  parseTime: number
  pageCount?: number
  metadata?: Record<string, string>
  error?: string
}

export interface TerminalTab {
  id: string
  title: string
  type: 'local' | 'ssh'
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
  // Agent 状态（每个终端独立）
  agentState?: AgentState
  // 上传的文档（每个终端独立）
  uploadedDocs?: ParsedDocument[]
}

export interface SplitPane {
  id: string
  type: 'terminal' | 'split'
  direction?: 'horizontal' | 'vertical'
  children?: SplitPane[]
  tabId?: string
  size?: number
}

export const useTerminalStore = defineStore('terminal', () => {
  // 状态
  const tabs = ref<TerminalTab[]>([])
  const activeTabId = ref<string>('')
  const splitLayout = ref<SplitPane | null>(null)
  // 待发送到 AI 分析的文本
  const pendingAiText = ref<string>('')
  // 终端计数器（用于生成唯一标题）
  const localTerminalCounter = ref(0)
  const sshTerminalCounters = ref<Record<string, number>>({})
  // 需要获得焦点的终端 ID（用于从 AI 助手发送代码后自动聚焦）
  const pendingFocusTabId = ref<string>('')
  
  // 屏幕服务实例存储（tabId -> TerminalScreenService）
  // 使用普通对象而非 ref，因为 TerminalScreenService 实例不需要响应式
  const screenServices = new Map<string, TerminalScreenService>()
  
  // 快照管理器存储（tabId -> TerminalSnapshotManager）
  const snapshotManagers = new Map<string, TerminalSnapshotManager>()

  // 计算属性
  const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value))
  const tabCount = computed(() => tabs.value.length)

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
      const shell = shellPath ? detectShellType(shellPath) : 'cmd'
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
        shellPath: shellPath || 'cmd.exe',
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
   * 发送文本到 AI 分析
   */
  function sendToAi(text: string): void {
    pendingAiText.value = text
  }

  /**
   * 清除待发送的 AI 文本
   */
  function clearPendingAiText(): void {
    pendingAiText.value = ''
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
    shell?: string  // 本地终端可指定 shell (cmd/powershell/bash 等)
  ): Promise<string> {
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
        
        const ptyId = await window.electronAPI.pty.create({
          cols: 80,
          rows: 24,
          shell: shell,
          encoding: localEncoding
        })
        reactiveTab.loadingMessage = undefined  // 清除加载提示
        reactiveTab.ptyId = ptyId
        reactiveTab.isConnected = true
        // 检测本地系统信息
        reactiveTab.systemInfo = detectLocalSystemInfo(shell)
      } else if (type === 'ssh' && sshConfig) {
        const sshId = await window.electronAPI.ssh.connect({
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          password: sshConfig.password,
          privateKeyPath: sshConfig.privateKeyPath,  // 私钥文件路径
          passphrase: sshConfig.passphrase,  // 私钥密码
          jumpHost: sshConfig.jumpHost,  // 传递跳板机配置
          encoding: sshConfig.encoding,  // 传递编码配置
          cols: 80,
          rows: 24
        })
        reactiveTab.ptyId = sshId
        reactiveTab.isConnected = true
        // SSH 连接默认假设是 Linux/Unix 系统
        const jumpInfo = sshConfig.jumpHost ? ` (via ${sshConfig.jumpHost.host})` : ''
        reactiveTab.systemInfo = {
          os: 'linux',
          shell: 'bash',
          description: `SSH 连接: ${sshConfig.username}@${sshConfig.host}${jumpInfo}`
        }
      }
    } catch (error) {
      console.error('Failed to create terminal:', error)
      reactiveTab.isConnected = false
      // 保存连接错误信息，便于显示给用户
      reactiveTab.connectionError = error instanceof Error ? error.message : '连接失败'
    } finally {
      reactiveTab.isLoading = false
    }

    return id
  }

  /**
   * 关闭标签页
   * @param tabId 标签页 ID
   * @param skipConfirm 是否跳过确认（默认 false）
   */
  async function closeTab(tabId: string, skipConfirm: boolean = false): Promise<boolean> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return false

    const t = i18n.global.t

    // 如果不跳过确认，检查是否需要确认
    if (!skipConfirm) {
      // 检查 Agent 是否正在运行
      const isAgentRunning = tab.agentState?.isRunning === true

      if (isAgentRunning) {
        // Agent 正在运行，显示警告确认
        const confirmed = window.confirm(t('tabs.confirmCloseAgentRunning'))
        if (!confirmed) return false
      }
    }

    // 清理终端连接
    if (tab.ptyId) {
      if (tab.type === 'local') {
        await window.electronAPI.pty.dispose(tab.ptyId)
      } else {
        await window.electronAPI.ssh.disconnect(tab.ptyId)
      }
    }

    // 移除标签
    const index = tabs.value.findIndex(t => t.id === tabId)
    tabs.value.splice(index, 1)

    // 如果关闭的是当前标签，切换到其他标签
    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const newIndex = Math.min(index, tabs.value.length - 1)
        activeTabId.value = tabs.value[newIndex].id
      } else {
        activeTabId.value = ''
      }
    }

    return true
  }

  /**
   * 重新连接 SSH 终端
   * 需要从 configStore 获取会话配置，返回 { success, needsSession } 指示结果
   */
  async function reconnectSsh(tabId: string): Promise<{ success: boolean; needsSession?: boolean }> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab || tab.type !== 'ssh') {
      console.error('Cannot reconnect: tab not found or not SSH type')
      return { success: false }
    }

    // 如果没有 sessionId，无法重连（配置未保存）
    if (!tab.sshSessionId) {
      console.warn('Cannot reconnect: no sessionId saved (session was not saved)')
      return { success: false, needsSession: true }
    }

    // 从 configStore 获取会话配置
    const configStore = useConfigStore()
    const session = configStore.sshSessions.find(s => s.id === tab.sshSessionId)
    if (!session) {
      console.error('Cannot reconnect: session not found in config')
      return { success: false, needsSession: true }
    }

    // 标记正在重连
    tab.isLoading = true
    tab.isConnected = false

    try {
      // 尝试断开旧连接（如果还存在）
      if (tab.ptyId) {
        try {
          await window.electronAPI.ssh.disconnect(tab.ptyId)
        } catch (e) {
          // 忽略断开连接的错误
        }
      }

      // 获取跳板机配置
      const jumpHost = configStore.getEffectiveJumpHost(session)

      // 使用会话配置重新连接
      const sshId = await window.electronAPI.ssh.connect({
        host: session.host,
        port: session.port,
        username: session.username,
        password: session.password,
        privateKeyPath: session.privateKeyPath,  // 私钥文件路径
        passphrase: session.passphrase,  // 私钥密码
        jumpHost,
        encoding: session.encoding || 'utf-8',
        cols: 80,
        rows: 24
      })

      // 更新 tab
      tab.ptyId = sshId
      tab.isConnected = true
      
      // 更新系统信息
      const jumpInfo = jumpHost ? ` (via ${jumpHost.host})` : ''
      tab.systemInfo = {
        os: 'linux',
        shell: 'bash',
        description: `SSH 连接: ${session.username}@${session.host}${jumpInfo}`
      }

      return { success: true }
    } catch (error) {
      console.error('Failed to reconnect SSH:', error)
      tab.isConnected = false
      throw error
    } finally {
      tab.isLoading = false
    }
  }

  /**
   * 切换标签页
   */
  function setActiveTab(tabId: string): void {
    if (tabs.value.find(t => t.id === tabId)) {
      activeTabId.value = tabId
    }
  }

  /**
   * 更新标签标题
   */
  function updateTabTitle(tabId: string, title: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.title = title
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
   * 向终端写入数据
   */
  async function writeToTerminal(tabId: string, data: string): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.ptyId) return

    if (tab.type === 'local') {
      await window.electronAPI.pty.write(tab.ptyId, data)
    } else {
      await window.electronAPI.ssh.write(tab.ptyId, data)
    }
  }

  /**
   * 调整终端大小
   */
  async function resizeTerminal(tabId: string, cols: number, rows: number): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.ptyId) return

    if (tab.type === 'local') {
      await window.electronAPI.pty.resize(tab.ptyId, cols, rows)
    } else {
      await window.electronAPI.ssh.resize(tab.ptyId, cols, rows)
    }
  }

  /**
   * 创建分屏
   */
  function splitTerminal(direction: 'horizontal' | 'vertical'): void {
    // TODO: 实现分屏逻辑
    console.log('Split terminal:', direction)
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
    const tab = tabs.value.find(t => t.agentState?.agentId === agentId)
    return tab?.id
  }

  /**
   * 根据 ptyId 查找对应的终端 ID
   * 用于 Agent 事件匹配（比 agentId 更可靠，因为 ptyId 在启动前就已知）
   */
  function findTabIdByPtyId(ptyId: string): string | undefined {
    const tab = tabs.value.find(t => t.ptyId === ptyId)
    return tab?.id
  }

  /**
   * 获取当前终端的 Agent 状态
   */
  function getAgentState(tabId: string): AgentState | undefined {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.agentState
  }

  /**
   * 设置 Agent 运行状态
   */
  function setAgentRunning(tabId: string, isRunning: boolean, agentId?: string, userTask?: string): void {
    console.log('[Store] setAgentRunning called:', { tabId, isRunning, agentId })
    const tabIndex = tabs.value.findIndex(t => t.id === tabId)
    if (tabIndex === -1) {
      console.warn('[Store] setAgentRunning: tab not found for tabId:', tabId)
      return
    }

    const tab = tabs.value[tabIndex]

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: [],
        history: []
      }
    }

    // 创建新的 agentState 对象以确保响应式更新
    tab.agentState = {
      ...tab.agentState,
      isRunning,
      ...(agentId !== undefined && { agentId }),
      ...(userTask !== undefined && { userTask }),
      ...(!isRunning && { pendingConfirm: undefined })
    }

    // 强制触发数组更新
    tabs.value = [...tabs.value]
    console.log('[Store] setAgentRunning completed, new isRunning:', tab.agentState.isRunning)
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
        steps: [],
        history: []
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
   * 添加或更新 Agent 执行步骤
   * 如果步骤 id 已存在，则更新；否则添加新步骤
   */
  function addAgentStep(tabId: string, step: AgentStep): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: [],
        history: []
      }
    }

    // 查找是否存在相同 id 的步骤
    const existingIndex = tab.agentState.steps.findIndex(s => s.id === step.id)
    
    if (existingIndex >= 0) {
      // 更新现有步骤（用于流式输出）
      tab.agentState.steps[existingIndex] = step
    } else {
      // 添加新步骤
      tab.agentState.steps.push(step)
    }
  }

  /**
   * 设置待确认的工具调用
   */
  function setAgentPendingConfirm(tabId: string, confirmation: PendingConfirmation | undefined): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState) return

    tab.agentState.pendingConfirm = confirmation
  }

  /**
   * 清空 Agent 当前任务状态（保留历史）
   */
  function clearAgentState(tabId: string, preserveHistory: boolean = true): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      const existingHistory = preserveHistory ? (tab.agentState?.history || []) : []
      const existingSteps = preserveHistory ? (tab.agentState?.steps || []) : []
      
      // 如果有已完成的任务，保存摘要到历史（用于 AI 上下文）
      if (preserveHistory && tab.agentState?.userTask && tab.agentState?.finalResult) {
        existingHistory.push({
          userTask: tab.agentState.userTask,
          steps: [],  // 历史中不需要保存步骤，UI 中已经保留了
          finalResult: tab.agentState.finalResult,
          timestamp: Date.now()
        })
        // 只保留最近 10 条历史摘要（用于 AI 上下文）
        while (existingHistory.length > 10) {
          existingHistory.shift()
        }
      }
      
      tab.agentState = {
        isRunning: false,
        steps: existingSteps,  // 保留之前的步骤，不清空
        history: existingHistory
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
   * 恢复历史 Agent 对话（从历史记录加载）
   */
  function restoreAgentHistory(tabId: string, record: {
    id: string
    timestamp: number
    userTask: string
    steps: Array<{
      id: string
      type: string
      content: string
      toolName?: string
      toolArgs?: Record<string, unknown>
      toolResult?: string
      riskLevel?: string
      timestamp: number
    }>
    finalResult?: string
    duration: number
    status: 'completed' | 'failed' | 'aborted'
  }): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    // 转换历史记录的 steps 为完整的 AgentStep 数组
    const steps: AgentStep[] = [
      // 添加 user_task 步骤
      {
        id: `user_task_${record.timestamp}`,
        type: 'user_task',
        content: record.userTask,
        timestamp: record.timestamp
      },
      // 转换记录中的步骤
      ...record.steps.map(s => ({
        id: s.id,
        type: s.type as AgentStep['type'],
        content: s.content,
        toolName: s.toolName,
        toolArgs: s.toolArgs,
        toolResult: s.toolResult,
        riskLevel: s.riskLevel as RiskLevel | undefined,
        timestamp: s.timestamp
      })),
      // 添加 final_result 步骤（如果有）
      ...(record.finalResult ? [{
        id: `final_result_${record.timestamp}`,
        type: 'final_result' as const,
        content: record.finalResult,
        timestamp: record.timestamp + record.duration
      }] : [])
    ]

    // 设置 agentState，将历史记录作为当前会话的上下文
    tab.agentState = {
      isRunning: false,
      steps: steps,
      history: [{
        userTask: record.userTask,
        steps: steps,
        finalResult: record.finalResult || '',
        timestamp: record.timestamp
      }],
      userTask: undefined,
      finalResult: undefined
    }
  }

  /**
   * 获取 Agent 上下文（用于发送给后端）
   * 返回纯 JavaScript 对象，确保可以通过 IPC 序列化
   */
  function getAgentContext(tabId: string) {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return null

    // 优先使用屏幕服务获取更准确的终端内容
    const screenService = screenServices.get(tabId)
    let terminalOutput: string[]
    
    if (screenService) {
      // 使用屏幕服务获取最近 50 行（更准确，直接从 xterm buffer 读取）
      terminalOutput = screenService.getLastNLines(50)
    } else {
      // 降级到输出缓冲区
      terminalOutput = (tab.outputBuffer || [])
        .slice(-50)
        .map(line => stripAnsi(line))
    }

    // 获取快照管理器的额外信息
    const snapshotManager = snapshotManagers.get(tabId)
    let isAtPrompt = false
    let cursorPosition = null
    
    if (screenService) {
      isAtPrompt = screenService.isAtPrompt()
      cursorPosition = screenService.getCursorPosition()
    }

    // 使用 JSON.parse(JSON.stringify()) 确保返回纯对象，移除 Proxy
    return JSON.parse(JSON.stringify({
      ptyId: tab.ptyId || '',
      terminalOutput, // 使用更准确的屏幕内容
      systemInfo: {
        os: tab.systemInfo?.os || 'unknown',
        shell: tab.systemInfo?.shell || 'unknown'
      },
      terminalType: tab.type, // 终端类型：'local' 或 'ssh'
      // 增强的状态信息
      isAtPrompt,
      cursorPosition,
      hasContentChanged: snapshotManager?.hasContentChanged() ?? true
    }))
  }

  // ==================== 文档管理 ====================

  /**
   * 获取终端的上传文档
   */
  function getUploadedDocs(tabId: string): ParsedDocument[] {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.uploadedDocs || []
  }

  /**
   * 设置终端的上传文档（替换模式，不是追加）
   */
  function setUploadedDocs(tabId: string, docs: ParsedDocument[]): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.uploadedDocs = docs
    }
  }

  /**
   * 添加文档到终端（追加到现有列表）
   */
  function addUploadedDocs(tabId: string, docs: ParsedDocument[]): void {
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
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab?.uploadedDocs) {
      tab.uploadedDocs.splice(index, 1)
    }
  }

  /**
   * 清空终端的所有文档
   */
  function clearUploadedDocs(tabId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.uploadedDocs = []
    }
  }

  // ==================== 屏幕服务管理 ====================

  /**
   * 注册屏幕服务实例
   * 由 Terminal.vue 组件在创建时调用
   */
  function registerScreenService(tabId: string, service: TerminalScreenService): void {
    screenServices.set(tabId, service)
  }

  /**
   * 注销屏幕服务实例
   * 由 Terminal.vue 组件在销毁时调用
   */
  function unregisterScreenService(tabId: string): void {
    screenServices.delete(tabId)
  }

  /**
   * 获取屏幕服务实例
   */
  function getScreenService(tabId: string): TerminalScreenService | undefined {
    return screenServices.get(tabId)
  }

  /**
   * 获取终端屏幕内容
   * 比 getRecentOutput 更准确，直接从 xterm buffer 读取
   */
  function getScreenContent(tabId: string): ScreenContent | null {
    const service = screenServices.get(tabId)
    if (!service) return null
    return service.getScreenContent()
  }

  /**
   * 获取终端最近 N 行（从屏幕服务获取，更准确）
   */
  function getScreenLastNLines(tabId: string, n: number): string[] {
    const service = screenServices.get(tabId)
    if (!service) {
      // 降级到 outputBuffer
      const tab = tabs.value.find(t => t.id === tabId)
      if (!tab?.outputBuffer) return []
      return tab.outputBuffer.slice(-n).map(line => stripAnsi(line))
    }
    return service.getLastNLines(n)
  }

  /**
   * 检测终端是否处于命令提示符状态
   */
  function isTerminalAtPrompt(tabId: string): boolean {
    const service = screenServices.get(tabId)
    if (!service) return false
    return service.isAtPrompt()
  }

  /**
   * 获取终端光标位置
   */
  function getCursorPosition(tabId: string): { x: number; y: number } | null {
    const service = screenServices.get(tabId)
    if (!service) return null
    return service.getCursorPosition()
  }

  /**
   * 检测终端屏幕中的错误信息
   */
  function detectScreenErrors(tabId: string, maxLines?: number): Array<{ line: number; content: string; type: string }> {
    const service = screenServices.get(tabId)
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
    const tab = tabs.value.find(t => t.id === tabId)
    return !!tab?.agentState?.pendingConfirm
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    tabCount,
    splitLayout,
    pendingAiText,
    pendingFocusTabId,
    createTab,
    closeTab,
    reconnectSsh,
    setActiveTab,
    updateTabTitle,
    updateConnectionStatus,
    updateSystemInfo,
    appendOutput,
    clearError,
    updateSelectedText,
    sendToAi,
    clearPendingAiText,
    getRecentOutput,
    writeToTerminal,
    resizeTerminal,
    splitTerminal,
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
    focusTerminal,
    clearPendingFocus,
    // Agent 状态管理
    findTabIdByAgentId,
    findTabIdByPtyId,
    getAgentState,
    setAgentRunning,
    setAgentId,
    addAgentStep,
    setAgentPendingConfirm,
    clearAgentState,
    setAgentFinalResult,
    restoreAgentHistory,
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
    hasPendingConfirm
  }
})

