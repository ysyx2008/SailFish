import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AiProfile, BondMetrics, DocumentParseProgress, FetchedAiModel, JumpHostConfig, PtyOptions, SftpConfig, SshConfig } from '@shared/types'

// ── 启动进度缓冲 ──────────────────────────────────────────────────────────────
// preload 加载后立即开始监听，将最新 stage 缓存下来。
// Vue onMounted 注册回调时，若事件已提前发出（主进程跑得比渲染快），
// 立即补发最后一条，确保 UI 能看到具体阶段名而不是兜底文字。
let _latestStartupStage: string | null = null
const _startupProgressCallbacks = new Set<(data: { stage: string }) => void>()
ipcRenderer.on('startup:progress', (_event, data: { stage: string }) => {
  _latestStartupStage = data.stage
  _startupProgressCallbacks.forEach(cb => cb(data))
  // done 后清缓存：避免 HMR 热重载时 renderer 重挂载还拿到旧的 done 补发
  if (data.stage === 'done') _latestStartupStage = null
})
// ─────────────────────────────────────────────────────────────────────────────

export type { AiProfile, JumpHostConfig, PtyOptions, SftpConfig, SshConfig }

// 更新状态类型
export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  info?: { version?: string; releaseNotes?: string; releaseDate?: string }
  progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number }
  error?: string
  sources?: {
    current: 'github' | 'oss'
    recommended: 'github' | 'oss'
    latency: Record<'github' | 'oss', number>
    labels: Record<'github' | 'oss', { zh: string; en: string }>
  }
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// 会话分组
export interface SessionGroup {
  id: string
  name: string
  jumpHost?: JumpHostConfig
}

export interface SshSession {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  group?: string           // 保留旧字段，兼容迁移
  groupId?: string         // 新字段：引用分组 ID
  jumpHostOverride?: JumpHostConfig | null  // 覆盖分组跳板机
}

// 定时任务相关类型
import type { ScheduleType, TaskRunStatus } from '@shared/types'
export type { ScheduleType, TaskRunStatus }
export type { TerminalType } from '@shared/types'
/** @deprecated Use TerminalType from @shared/types */
export type TargetType = import('@shared/types').TerminalType

export interface ScheduleConfig {
  type: ScheduleType
  expression: string
}

export interface TargetConfig {
  type: TargetType
  sshSessionId?: string
  sshSessionName?: string
  workingDirectory?: string
}

export interface TaskOptions {
  timeout: number
  requireConfirm: boolean
  notifyOnComplete: boolean
  notifyOnError: boolean
}

export interface TaskRunRecord {
  at: number
  status: TaskRunStatus
  duration: number
  output?: string
  error?: string
}

export interface ScheduledTask {
  id: string
  name: string
  description?: string
  enabled: boolean
  schedule: ScheduleConfig
  prompt: string
  target: TargetConfig
  options: TaskOptions
  createdAt: number
  updatedAt: number
  lastRun?: TaskRunRecord
  nextRun?: number
}

export interface TaskHistoryRecord extends TaskRunRecord {
  id: string
  taskId: string
  taskName: string
}

export interface CreateTaskParams {
  name: string
  description?: string
  schedule: ScheduleConfig
  prompt: string
  target: TargetConfig
  options?: Partial<TaskOptions>
  enabled?: boolean
}

export interface TaskExecutionResult {
  success: boolean
  output: string
  error?: string
  duration: number
}

export interface XshellSession {
  name: string
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  group?: string
}

export interface ImportResult {
  success: boolean
  sessions: XshellSession[]
  errors: string[]
}

// 文件书签类型
export interface FileBookmark {
  id: string
  name: string
  path: string
  type: 'local' | 'remote'
  hostId?: string      // SSH 会话 ID（远程书签）
  hostName?: string    // 主机名称（显示用）
  createdAt: number
}

export interface SftpFileInfo {
  name: string
  path: string
  size: number
  modifyTime: number
  accessTime: number
  isDirectory: boolean
  isSymlink: boolean
  permissions: {
    user: string
    group: string
    other: string
  }
  owner: number
  group: number
}

export interface TransferProgress {
  transferId: string
  filename: string
  localPath: string
  remotePath: string
  direction: 'upload' | 'download'
  totalBytes: number
  transferredBytes: number
  percent: number
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled'
  error?: string
  startTime: number
}

// MCP 相关类型
export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  whenToUse?: string
}

export interface McpTool {
  serverId: string
  serverName: string
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface McpResource {
  serverId: string
  serverName: string
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpPrompt {
  serverId: string
  serverName: string
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
}

export interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  error?: string
  toolCount: number
  resourceCount: number
  promptCount: number
}

// 用户技能类型
export interface UserSkill {
  id: string
  name: string
  description: string
  version?: string
  enabled: boolean
  content: string
  filePath: string
  lastModified: number
}

// Agent 相关类型（从共享类型导入）
import type { ExecutionMode, RemoteChannel, AgentStep, PendingConfirmation, IMProcessMode, AgentContext } from '@shared/types'
export type { ExecutionMode, RemoteChannel, RiskLevel, AgentStep, PendingConfirmation, IMProcessMode, AgentContext } from '@shared/types'

export interface AgentConfig {
  enabled?: boolean
  maxSteps?: number
  commandTimeout?: number
  autoExecuteSafe?: boolean
  autoExecuteModerate?: boolean
  executionMode?: ExecutionMode
}

// 暴露给渲染进程的 API
const electronAPI = {
  // 应用信息
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion') as Promise<string>,
    getMessagingDocsPath: () => ipcRenderer.invoke('app:getMessagingDocsPath') as Promise<string>,
    // 渲染端 Vue mount 完成后调用，主进程据此决定何时 show 主窗口，
    // 避免在 ready-to-show 时 show 出"还没挂 UI 的黑屏窗口"。
    notifyMounted: () => ipcRenderer.send('app:mounted'),
    onRunTask: (callback: (task: string) => void) => {
      const handler = (_event: unknown, task: string) => callback(task)
      ipcRenderer.on('app:run-task', handler)
      return () => {
        ipcRenderer.removeListener('app:run-task', handler)
      }
    },
    onInstallSkill: (callback: (skillId: string) => void) => {
      const handler = (_event: unknown, skillId: string) => callback(skillId)
      ipcRenderer.on('app:install-skill', handler)
      return () => {
        ipcRenderer.removeListener('app:install-skill', handler)
      }
    },
    // 后端服务启动进度（用于诊断 Windows 无响应时卡在哪个阶段）
    onStartupProgress: (callback: (data: { stage: string }) => void) => {
      _startupProgressCallbacks.add(callback)
      // 补发：若事件在 renderer 订阅前已发出，立即回调最新 stage
      if (_latestStartupStage !== null) {
        callback({ stage: _latestStartupStage })
      }
      return () => {
        _startupProgressCallbacks.delete(callback)
      }
    },
  },

  // PATH 环境变量状态
  path: {
    // 检查 PATH 是否已就绪
    isReady: () => ipcRenderer.invoke('path:isReady') as Promise<boolean>,
    // 等待 PATH 就绪
    waitReady: () => ipcRenderer.invoke('path:waitReady') as Promise<boolean>,
    // 监听 PATH 就绪事件
    onReady: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('path:ready', handler)
      return () => {
        ipcRenderer.removeListener('path:ready', handler)
      }
    }
  },

  // 窗口操作
  window: {
    close: () => ipcRenderer.invoke('window:close'),
    forceQuit: () => ipcRenderer.invoke('window:forceQuit'),
    // Windows 焦点恢复：请求主进程让 webContents 获得键盘焦点
    focusWebContents: () => ipcRenderer.send('window:focusWebContents'),
    // Windows 自绘标题栏：最小化 / 最大化-还原（渲染端 WindowControls 调用，非 Windows 平台不会调）
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
    onMaximizeStateChange: (callback: (isMaximized: boolean) => void) => {
      const handler = (_e: unknown, isMaximized: boolean) => callback(isMaximized)
      ipcRenderer.on('window:maximizeChange', handler)
      return () => {
        ipcRenderer.removeListener('window:maximizeChange', handler)
      }
    },
    // Windows 汉堡菜单：弹出 menuService 注册的应用菜单（在 frame:false 下原生菜单栏不显示，由此入口替代）
    popupAppMenu: (position?: { x: number; y: number }) =>
      ipcRenderer.send('window:popupAppMenu', position),
    // 监听主进程请求终端数量
    onRequestTerminalCount: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('window:requestTerminalCount', handler)
      return () => {
        ipcRenderer.removeListener('window:requestTerminalCount', handler)
      }
    },
    // 响应终端数量
    responseTerminalCount: (count: number) => {
      ipcRenderer.send('window:terminalCountResponse', count)
    },
    // 查询窗口是否处于全屏
    isFullScreen: () => ipcRenderer.invoke('window:isFullScreen') as Promise<boolean>,
    // 监听全屏状态变化
    onFullScreenChange: (callback: (isFullScreen: boolean) => void) => {
      const handler = (_e: unknown, isFullScreen: boolean) => callback(isFullScreen)
      ipcRenderer.on('window:fullscreenChange', handler)
      return () => {
        ipcRenderer.removeListener('window:fullscreenChange', handler)
      }
    }
  },

  // 自动更新
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates') as Promise<{
      success: boolean
      updateInfo?: { version: string; releaseNotes?: string; releaseDate?: string }
      error?: string
    }>,

    downloadUpdate: (source?: 'github' | 'oss') => ipcRenderer.invoke('updater:downloadUpdate', source) as Promise<{
      success: boolean
      source?: 'github' | 'oss'
      error?: string
    }>,

    setSource: (source: 'github' | 'oss') => ipcRenderer.invoke('updater:setSource', source) as Promise<{
      success: boolean
      error?: string
    }>,

    quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall') as Promise<{
      success: boolean
      error?: string
    }>,

    deferInstall: () => ipcRenderer.invoke('updater:deferInstall') as Promise<{
      success: boolean
      error?: string
    }>,

    isInstallDeferred: () => ipcRenderer.invoke('updater:isInstallDeferred') as Promise<{
      deferred: boolean
      version?: string
    }>,

    getStatus: () => ipcRenderer.invoke('updater:getStatus') as Promise<UpdateStatus>,

    onStatusChanged: (callback: (status: UpdateStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status)
      ipcRenderer.on('updater:status-changed', handler)
      return () => {
        ipcRenderer.removeListener('updater:status-changed', handler)
      }
    }
  },

  // PTY 操作
  pty: {
    create: (options: PtyOptions) =>
      ipcRenderer.invoke('pty:create', options) as Promise<{
        id: string
        shellPath: string
        shellKind: 'powershell' | 'cmd' | 'bash'
      }>,
    write: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resize', id, cols, rows),
    dispose: (id: string) => ipcRenderer.invoke('pty:dispose', id),
    executeInTerminal: (id: string, command: string, timeout?: number) =>
      ipcRenderer.invoke('pty:executeInTerminal', id, command, timeout) as Promise<
        | { status: 'completed'; output: string; duration: number }
        | { status: 'timeout'; output: string; duration: number }
        | { status: 'no_instance'; ptyId: string }
      >,
    getAvailableShells: () => ipcRenderer.invoke('pty:getAvailableShells') as Promise<Array<{
      label: string
      value: string
      icon: string
    }>>,
    onData: (id: string, callback: (data: string) => void) => {
      ipcRenderer.send('pty:subscribe', id)
      const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(`pty:data:${id}`, handler)
      return () => {
        ipcRenderer.removeListener(`pty:data:${id}`, handler)
      }
    }
  },

  // SSH 操作
  ssh: {
    connect: (config: SshConfig, options?: { reuseId?: string; attemptId?: string }) =>
      ipcRenderer.invoke('ssh:connect', config, options),
    cancelConnect: (attemptId: string) => ipcRenderer.invoke('ssh:cancelConnect', attemptId),
    write: (id: string, data: string) => ipcRenderer.invoke('ssh:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('ssh:resize', id, cols, rows),
    disconnect: (id: string) => ipcRenderer.invoke('ssh:disconnect', id),
    onData: (id: string, callback: (data: string) => void) => {
      ipcRenderer.send('ssh:subscribe', id)
      const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(`ssh:data:${id}`, handler)
      return () => {
        ipcRenderer.removeListener(`ssh:data:${id}`, handler)
        // 通知后端取消订阅，释放资源
        ipcRenderer.send('ssh:unsubscribe', id)
      }
    },
    // 监听 SSH 断开连接事件
    onDisconnected: (id: string, callback: (event: { reason: string; error?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { reason: string; error?: string }) => callback(data)
      ipcRenderer.on(`ssh:disconnected:${id}`, handler)
      return () => {
        ipcRenderer.removeListener(`ssh:disconnected:${id}`, handler)
      }
    }
  },

  // 终端状态服务
  terminalState: {
    // 初始化终端状态
    init: (id: string, type: 'local' | 'ssh', initialCwd?: string) =>
      ipcRenderer.invoke('terminalState:init', id, type, initialCwd),
    // 移除终端状态
    remove: (id: string) => ipcRenderer.invoke('terminalState:remove', id),
    // 获取终端状态
    get: (id: string) => ipcRenderer.invoke('terminalState:get', id) as Promise<{
      id: string
      type: 'local' | 'ssh'
      cwd: string
      cwdUpdatedAt: number
      lastCommand?: string
      lastExitCode?: number
      isIdle: boolean
      lastActivityAt: number
    } | undefined>,
    // 获取当前工作目录
    getCwd: (id: string) => ipcRenderer.invoke('terminalState:getCwd', id) as Promise<string>,
    // 刷新 CWD（执行 pwd 验证）
    refreshCwd: (id: string) => ipcRenderer.invoke('terminalState:refreshCwd', id) as Promise<string>,
    // 手动更新 CWD
    updateCwd: (id: string, newCwd: string) =>
      ipcRenderer.invoke('terminalState:updateCwd', id, newCwd),
    // 处理用户输入（追踪可能的 CWD 变化）
    handleInput: (id: string, input: string) =>
      ipcRenderer.invoke('terminalState:handleInput', id, input),
    // 获取终端空闲状态
    getIdleState: (id: string) =>
      ipcRenderer.invoke('terminalState:getIdleState', id) as Promise<boolean>,
    // 监听 CWD 变化事件
    onCwdChange: (callback: (event: {
      terminalId: string
      oldCwd: string
      newCwd: string
      timestamp: number
      trigger: 'command' | 'pwd_check' | 'initial'
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('terminal:cwdChange', handler)
      return () => {
        ipcRenderer.removeListener('terminal:cwdChange', handler)
      }
    },
    
    // ==================== 命令执行追踪 ====================
    
    // 开始追踪命令执行
    startExecution: (
      id: string, 
      command: string,
      options?: { source?: 'user' | 'agent'; agentStepTitle?: string }
    ) =>
      ipcRenderer.invoke('terminalState:startExecution', id, command, options) as Promise<{
        id: string
        terminalId: string
        command: string
        startTime: number
        cwdBefore: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
        output?: string
        source?: 'user' | 'agent'
        agentStepTitle?: string
      } | null>,
    
    // 追加命令输出
    appendOutput: (id: string, output: string) =>
      ipcRenderer.invoke('terminalState:appendOutput', id, output),
    
    // 完成命令执行
    completeExecution: (id: string, exitCode?: number, status?: 'completed' | 'failed' | 'timeout' | 'cancelled') =>
      ipcRenderer.invoke('terminalState:completeExecution', id, exitCode, status) as Promise<{
        id: string
        terminalId: string
        command: string
        startTime: number
        endTime?: number
        duration?: number
        exitCode?: number
        output?: string
        cwdBefore: string
        cwdAfter?: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
      } | null>,
    
    // 获取当前正在执行的命令
    getCurrentExecution: (id: string) =>
      ipcRenderer.invoke('terminalState:getCurrentExecution', id) as Promise<{
        id: string
        terminalId: string
        command: string
        startTime: number
        cwdBefore: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
        output?: string
      } | undefined>,
    
    // 获取命令执行历史
    getExecutionHistory: (id: string, limit?: number) =>
      ipcRenderer.invoke('terminalState:getExecutionHistory', id, limit) as Promise<Array<{
        id: string
        terminalId: string
        command: string
        startTime: number
        endTime?: number
        duration?: number
        exitCode?: number
        output?: string
        cwdBefore: string
        cwdAfter?: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
      }>>,
    
    // 获取最后一次命令执行
    getLastExecution: (id: string) =>
      ipcRenderer.invoke('terminalState:getLastExecution', id) as Promise<{
        id: string
        terminalId: string
        command: string
        startTime: number
        endTime?: number
        duration?: number
        exitCode?: number
        output?: string
        cwdBefore: string
        cwdAfter?: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
      } | undefined>,
    
    // 清除命令执行历史
    clearExecutionHistory: (id: string) =>
      ipcRenderer.invoke('terminalState:clearExecutionHistory', id),
    
    // 监听命令执行事件
    onCommandExecution: (callback: (event: {
      type: 'start' | 'output' | 'complete'
      execution: {
        id: string
        terminalId: string
        command: string
        startTime: number
        endTime?: number
        duration?: number
        exitCode?: number
        output?: string
        cwdBefore: string
        cwdAfter?: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
        /** 命令来源：user=用户输入，agent=AI Agent */
        source?: 'user' | 'agent'
        /** Agent 执行时的步骤标题 */
        agentStepTitle?: string
      }
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('terminal:commandExecution', handler)
      return () => {
        ipcRenderer.removeListener('terminal:commandExecution', handler)
      }
    }
  },

  // 终端感知服务
  terminalAwareness: {
    // 获取终端感知状态（综合分析）
    getAwareness: (ptyId: string) =>
      ipcRenderer.invoke('terminalAwareness:getAwareness', ptyId) as Promise<{
        status: 'idle' | 'busy' | 'waiting_input' | 'stuck'
        input: {
          isWaiting: boolean
          type: 'password' | 'confirmation' | 'selection' | 'pager' | 'prompt' | 'editor' | 'custom_input' | 'none'
          prompt?: string
          options?: string[]
          suggestedResponse?: string
          confidence: number
        }
        process: {
          status: 'idle' | 'running_interactive' | 'running_streaming' | 'running_silent' | 'possibly_stuck' | 'waiting_input'
          foregroundProcess?: string
          pid?: number
          runningTime?: number
          lastOutputTime?: number
          outputRate?: number
          isKnownLongRunning?: boolean
          suggestion?: string
        }
        context: {
          user?: string
          hostname?: string
          isRoot: boolean
          cwdFromPrompt?: string
          activeEnvs: string[]
          sshDepth: number
          promptType: 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd' | 'unknown'
        }
        output: {
          type: 'progress' | 'compilation' | 'test' | 'log_stream' | 'error' | 'table' | 'normal'
          confidence: number
          details?: {
            progress?: number
            testsPassed?: number
            testsFailed?: number
            errorCount?: number
            eta?: string
          }
        }
        terminalState?: {
          cwd: string
          lastCommand?: string
          lastExitCode?: number
          isIdle: boolean
        }
        currentExecution?: {
          id: string
          terminalId: string
          command: string
          startTime: number
          cwdBefore: string
          status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
          output?: string
        }
        suggestion: string
        canExecuteCommand: boolean
        needsUserInput: boolean
        timestamp: number
      }>,

    // 追踪输出（用于输出速率计算）
    trackOutput: (ptyId: string, lineCount: number) =>
      ipcRenderer.invoke('terminalAwareness:trackOutput', ptyId, lineCount),

    // 获取终端可视区域内容
    getVisibleContent: (ptyId: string) =>
      ipcRenderer.invoke('terminalAwareness:getVisibleContent', ptyId) as Promise<string[] | null>,

    // 检查是否可以执行命令
    canExecute: (ptyId: string) =>
      ipcRenderer.invoke('terminalAwareness:canExecute', ptyId) as Promise<boolean>,

    // 获取执行命令前的建议
    getPreExecutionAdvice: (ptyId: string, command: string) =>
      ipcRenderer.invoke('terminalAwareness:getPreExecutionAdvice', ptyId, command) as Promise<{
        canExecute: boolean
        reason?: string
        suggestion?: string
      }>,

    // 清理终端感知数据
    clear: (ptyId: string) =>
      ipcRenderer.invoke('terminalAwareness:clear', ptyId)
  },

  // AI 操作
  ai: {
    chat: (messages: AiMessage[], profileId?: string) =>
      ipcRenderer.invoke('ai:chat', messages, profileId),
    chatStream: (
      messages: AiMessage[],
      onChunk: (chunk: string) => void,
      onDone: () => void,
      onError: (error: string) => void,
      profileId?: string,
      requestId?: string  // 支持传入请求 ID，用于支持多个终端同时请求
    ) => {
      ipcRenderer.invoke('ai:chatStream', messages, profileId, requestId).then((streamId: string) => {
        const handler = (
          _event: Electron.IpcRendererEvent,
          data: { chunk?: string; done?: boolean; error?: string }
        ) => {
          if (data.chunk) {
            onChunk(data.chunk)
          }
          if (data.done) {
            onDone()
            ipcRenderer.removeListener(`ai:stream:${streamId}`, handler)
          }
          if (data.error) {
            onError(data.error)
            ipcRenderer.removeListener(`ai:stream:${streamId}`, handler)
          }
        }
        ipcRenderer.on(`ai:stream:${streamId}`, handler)
      })
    },
    abort: (requestId?: string) => ipcRenderer.invoke('ai:abort', requestId),
    testApiKey: (profile: Partial<AiProfile>) =>
      ipcRenderer.invoke('ai:testApiKey', profile) as Promise<{ success: boolean; message: string; latencyMs?: number }>,
    fetchModels: (profile: Partial<AiProfile>) =>
      ipcRenderer.invoke('ai:fetchModels', profile) as Promise<{
        models: FetchedAiModel[]
        error?: string
      }>,
    /** 指定 AI 配置失效并已回退到其它配置时通知前端（toast） */
    onProfileFallback: (callback: (notice: { requestedId: string; usedId: string; usedName: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, notice: { requestedId: string; usedId: string; usedName: string }) => {
        callback(notice)
      }
      ipcRenderer.on('ai:profile-fallback', handler)
      return () => { ipcRenderer.removeListener('ai:profile-fallback', handler) }
    }
  },

  // 配置操作
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('config:set', key, value),
    getAll: () => ipcRenderer.invoke('config:getAll'),
    onChanged: (callback: (payload?: { sshSessions?: SshSession[]; sessionGroups?: SessionGroup[] }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload?: { sshSessions?: SshSession[]; sessionGroups?: SessionGroup[] }) => callback(payload)
      ipcRenderer.on('config:changed', handler)
      return () => { ipcRenderer.removeListener('config:changed', handler) }
    },
    onUiZoomChanged: (callback: (factor: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, factor: number) => callback(factor)
      ipcRenderer.on('ui-zoom:changed', handler)
      return () => { ipcRenderer.removeListener('ui-zoom:changed', handler) }
    },
    getRecoveryNotice: () =>
      ipcRenderer.invoke('config:getRecoveryNotice') as Promise<{
        kind: 'restored' | 'reset'
        from?: string
        at: number
      } | null>,
    dismissRecoveryNotice: () => ipcRenderer.invoke('config:dismissRecoveryNotice') as Promise<void>,

    // AI 配置
    getAiProfiles: () => ipcRenderer.invoke('config:getAiProfiles'),
    setAiProfiles: (profiles: AiProfile[]) =>
      ipcRenderer.invoke('config:setAiProfiles', profiles),
    getActiveAiProfile: () => ipcRenderer.invoke('config:getActiveAiProfile'),
    setActiveAiProfile: (profileId: string) =>
      ipcRenderer.invoke('config:setActiveAiProfile', profileId),
    hasVisionCapability: () => ipcRenderer.invoke('config:hasVisionCapability') as Promise<boolean>,

    // SSH 会话
    getSshSessions: () => ipcRenderer.invoke('config:getSshSessions'),
    setSshSessions: (sessions: SshSession[]) =>
      ipcRenderer.invoke('config:setSshSessions', sessions),

    // 会话分组
    getSessionGroups: () => ipcRenderer.invoke('config:getSessionGroups') as Promise<SessionGroup[]>,
    setSessionGroups: (groups: SessionGroup[]) =>
      ipcRenderer.invoke('config:setSessionGroups', groups),

    // 主题
    getTheme: () => ipcRenderer.invoke('config:getTheme'),
    setTheme: (theme: string) => ipcRenderer.invoke('config:setTheme', theme),

    // UI 主题
    getUiTheme: () => ipcRenderer.invoke('config:getUiTheme') as Promise<import('@shared/types').UiThemeName>,
    setUiTheme: (theme: import('@shared/types').UiThemeName) => ipcRenderer.invoke('config:setUiTheme', theme),

    // UI 主题模式（manual / auto）
    getUiThemeMode: () => ipcRenderer.invoke('config:getUiThemeMode') as Promise<import('@shared/types').UiThemeMode>,
    setUiThemeMode: (mode: import('@shared/types').UiThemeMode) => ipcRenderer.invoke('config:setUiThemeMode', mode),

    // 系统当前外观（dark/light），用于 auto 模式
    getSystemColorScheme: () => ipcRenderer.invoke('system:getColorScheme') as Promise<import('@shared/types').SystemColorScheme>,
    onSystemColorSchemeChanged: (callback: (scheme: import('@shared/types').SystemColorScheme) => void) => {
      const listener = (_event: unknown, scheme: import('@shared/types').SystemColorScheme) => callback(scheme)
      ipcRenderer.on('system:colorSchemeChanged', listener)
      return () => ipcRenderer.removeListener('system:colorSchemeChanged', listener)
    },

    // Agent MBTI
    getAgentMbti: () => ipcRenderer.invoke('config:getAgentMbti') as Promise<string | null>,
    setAgentMbti: (mbti: string | null) => ipcRenderer.invoke('config:setAgentMbti', mbti),

    // Agent 调试模式
    getAgentDebugMode: () => ipcRenderer.invoke('config:getAgentDebugMode') as Promise<boolean>,
    setAgentDebugMode: (enabled: boolean) => ipcRenderer.invoke('config:setAgentDebugMode', enabled),

    // 首次设置向导
    getSetupCompleted: () => ipcRenderer.invoke('config:getSetupCompleted') as Promise<boolean>,
    setSetupCompleted: (completed: boolean) => ipcRenderer.invoke('config:setSetupCompleted', completed),

    // Agent 诞生引导
    getAgentOnboardingCompleted: () => ipcRenderer.invoke('config:getAgentOnboardingCompleted') as Promise<boolean>,

    // 语言设置
    getLanguage: () => ipcRenderer.invoke('config:getLanguage') as Promise<string>,
    setLanguage: (language: string) => ipcRenderer.invoke('config:setLanguage', language),

    // 快捷键
    setKeyboardShortcuts: (shortcuts: Record<string, string>) => ipcRenderer.invoke('config:setKeyboardShortcuts', shortcuts),

    // 赞助状态
    getSponsorStatus: () => ipcRenderer.invoke('config:getSponsorStatus') as Promise<boolean>,
    setSponsorStatus: (status: boolean) => ipcRenderer.invoke('config:setSponsorStatus', status),

    // 排序设置
    getSessionSortBy: () => ipcRenderer.invoke('config:getSessionSortBy') as Promise<string>,
    setSessionSortBy: (sortBy: string) => ipcRenderer.invoke('config:setSessionSortBy', sortBy),
    getDefaultGroupSortOrder: () => ipcRenderer.invoke('config:getDefaultGroupSortOrder') as Promise<number>,
    setDefaultGroupSortOrder: (order: number) => ipcRenderer.invoke('config:setDefaultGroupSortOrder', order),

    // 文件书签
    getFileBookmarks: () => ipcRenderer.invoke('config:getFileBookmarks') as Promise<FileBookmark[]>,
    setFileBookmarks: (bookmarks: FileBookmark[]) => ipcRenderer.invoke('config:setFileBookmarks', bookmarks),
    addFileBookmark: (bookmark: FileBookmark) => ipcRenderer.invoke('config:addFileBookmark', bookmark),
    updateFileBookmark: (bookmark: FileBookmark) => ipcRenderer.invoke('config:updateFileBookmark', bookmark),
    deleteFileBookmark: (id: string) => ipcRenderer.invoke('config:deleteFileBookmark', id),
    getLocalBookmarks: () => ipcRenderer.invoke('config:getLocalBookmarks') as Promise<FileBookmark[]>,
    getRemoteBookmarks: (hostId?: string) => ipcRenderer.invoke('config:getRemoteBookmarks', hostId) as Promise<FileBookmark[]>,

    // AI Rules
    getAiRules: () => ipcRenderer.invoke('config:getAiRules') as Promise<string>,
    setAiRules: (rules: string) => ipcRenderer.invoke('config:setAiRules', rules),
    // Agent 个性描述（legacy）
    getAgentPersonalityText: () => ipcRenderer.invoke('config:getAgentPersonalityText') as Promise<string>,
    setAgentPersonalityText: (text: string) => ipcRenderer.invoke('config:setAgentPersonalityText', text),
    // Agent 身份文件（IDENTITY.md / SOUL.md / USER.md）
    readIdentityFile: (filename: string) => ipcRenderer.invoke('agent:readIdentityFile', filename) as Promise<string>,
    writeIdentityFile: (filename: string, content: string) => ipcRenderer.invoke('agent:writeIdentityFile', filename, content) as Promise<void>,
    // AI 名字
    getAgentName: () => ipcRenderer.invoke('config:getAgentName') as Promise<string>,
    setAgentName: (name: string) => ipcRenderer.invoke('config:setAgentName', name),
    // AI 头像
    getAgentAvatar: () => ipcRenderer.invoke('config:getAgentAvatar') as Promise<string>,
    setAgentAvatar: (dataUrl: string) => ipcRenderer.invoke('config:setAgentAvatar', dataUrl),

    // 日志级别
    getLogLevel: () => ipcRenderer.invoke('config:getLogLevel') as Promise<string>,
    setLogLevel: (level: string) => ipcRenderer.invoke('config:setLogLevel', level),

    // 日志目录
    getLogDir: () => ipcRenderer.invoke('config:getLogDir') as Promise<string | null>,
    openLogDir: () => ipcRenderer.invoke('config:openLogDir') as Promise<void>
  },

  // 崩溃诊断
  diagnostics: {
    getCrashSummary: () => ipcRenderer.invoke('diagnostics:getCrashSummary') as Promise<import('@sailfish/shared-types').CrashSummary>,
    getCrashSummaryText: () => ipcRenderer.invoke('diagnostics:getCrashSummaryText') as Promise<string>,
    createPackage: (options?: { chooseLocation?: boolean }) =>
      ipcRenderer.invoke('diagnostics:createPackage', options) as Promise<import('@sailfish/shared-types').DiagnosticsPackageResult>,
    revealPackage: (filePath: string) => ipcRenderer.invoke('diagnostics:revealPackage', filePath) as Promise<void>,
    getNotifyEnabled: () => ipcRenderer.invoke('diagnostics:getNotifyEnabled') as Promise<boolean>,
    setNotifyEnabled: (enabled: boolean) => ipcRenderer.invoke('diagnostics:setNotifyEnabled', enabled) as Promise<void>
  },

  // Xshell 导入操作
  xshell: {
    selectFiles: () => ipcRenderer.invoke('xshell:selectFiles') as Promise<{ canceled: boolean; filePaths: string[] }>,
    selectDirectory: () => ipcRenderer.invoke('xshell:selectDirectory') as Promise<{ canceled: boolean; dirPath: string }>,
    importFiles: (filePaths: string[]) => ipcRenderer.invoke('xshell:importFiles', filePaths) as Promise<ImportResult>,
    importDirectory: (dirPath: string) => ipcRenderer.invoke('xshell:importDirectory', dirPath) as Promise<ImportResult>,
    importDirectories: (dirPaths: string[]) => ipcRenderer.invoke('xshell:importDirectories', dirPaths) as Promise<ImportResult>,
    scanDefaultPaths: () => ipcRenderer.invoke('xshell:scanDefaultPaths') as Promise<{ found: boolean; paths: string[]; sessionCount: number }>
  },

  // Agent 操作
  agent: {
    // 运行 Agent
    run: (
      ptyId: string,
      message: string,
      context: AgentContext,
      config?: AgentConfig,
      profileId?: string
    ) => ipcRenderer.invoke('agent:run', { ptyId, message, context, config, profileId }) as Promise<{ success: boolean; result?: string; error?: string; aborted?: boolean }>,

    // 运行独立助手 Agent（无终端绑定）
    runStandalone: (
      agentId: string,
      message: string,
      context: AgentContext,
      config?: AgentConfig,
      profileId?: string
    ) => ipcRenderer.invoke('agent:runStandalone', { agentId, message, context, config, profileId }) as Promise<{ success: boolean; result?: string; error?: string; aborted?: boolean }>,

    // 中止 Agent（使用 ptyId 或 agentId）
    abort: (ptyId: string) => ipcRenderer.invoke('agent:abort', ptyId) as Promise<boolean>,

    compactContext: (params: {
      agentKey: string
      sessionId?: string
      sessionStartTime?: number
      terminalType: import('@shared/types').TerminalType
      sshHost?: string
      hint?: string
    }) => ipcRenderer.invoke('agent:compactContext', params) as Promise<
      | { ok: true; freedTokens: number; beforeTokens: number; afterTokens: number }
      | { ok: false; reason: 'running' | 'empty' | 'failed' }
    >,

    // 确认工具调用（使用 ptyId）
    confirm: (params: {
      ptyId: string
      toolCallId: string
      approved: boolean
      modifiedArgs?: Record<string, unknown>
      alwaysAllow?: boolean
    }) => ipcRenderer.invoke('agent:confirm', params) as Promise<boolean>,

    // 解决安全输入请求（前端安全输入框完成后调用）
    resolveSecureInput: (params: {
      ptyId: string
      requestId: string
      value?: string
      cancelled?: boolean
    }) => ipcRenderer.invoke('agent:resolveSecureInput', params) as Promise<boolean>,

    // 获取 Agent 状态（使用 ptyId）
    getStatus: (ptyId: string) => ipcRenderer.invoke('agent:getStatus', ptyId),

    // 清理 Agent 运行记录（使用 ptyId）
    cleanup: (ptyId: string) => ipcRenderer.invoke('agent:cleanup', ptyId),

    pinSkill: (agentKey: string, skillId: string) =>
      ipcRenderer.invoke('agent:pinSkill', agentKey, skillId) as Promise<{
        ok: boolean
        error?: string
        skills: Array<{ id: string; name: string; description?: string; unavailable?: boolean }>
      }>,
    unpinSkill: (agentKey: string, skillId: string) =>
      ipcRenderer.invoke('agent:unpinSkill', agentKey, skillId) as Promise<{
        ok: true
        skills: Array<{ id: string; name: string; description?: string; unavailable?: boolean }>
      }>,
    hydrateSkills: (agentKey: string, loadedSkills?: string[], userDismissedSkills?: string[]) =>
      ipcRenderer.invoke('agent:hydrateSkills', agentKey, loadedSkills, userDismissedSkills) as Promise<Array<{ id: string; name: string; description?: string; unavailable?: boolean }>>,
    getVisibleSkills: (agentKey: string) =>
      ipcRenderer.invoke('agent:getVisibleSkills', agentKey) as Promise<Array<{ id: string; name: string; description?: string; unavailable?: boolean }>>,
    onSkillsChanged: (callback: (data: { agentId: string; skills: Array<{ id: string; name: string; description?: string; unavailable?: boolean }> }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; skills: Array<{ id: string; name: string; description?: string; unavailable?: boolean }> }) => callback(data)
      ipcRenderer.on('agent:skillsChanged', handler)
      return () => {
        ipcRenderer.removeListener('agent:skillsChanged', handler)
      }
    },

    // Fork Agent：从源 Agent 会话分叉出新的助手 Agent（"另开一聊"）
    // untilTaskCount：截断到第 N 个 task（包含），undefined = 全部
    // newRecord：截断后的完整 AgentRecord，前端用它恢复新 tab 的 UI 历史
    fork: (opts: {
      sourceAgentKey: string
      newAgentId: string
      untilTaskCount?: number
      targetMode?: 'assistant'
      titleSuffix?: string
      sourceSessionId?: string
    }) => ipcRenderer.invoke('agent:fork', opts) as Promise<{
      newSessionId: string
      newAgentId: string
      sourceUserTask: string
      newRecord: import('@shared/types').AgentRecord
    } | null>,

    // Fork Task（task → task 同质分叉）：从源 task Agent 会话分叉出新助手 Agent。
    // 与 fork 的区别：语义明确，不走 companion 分支。companion 走 extractTaskFromCompanion。
    forkTask: (opts: {
      sourceAgentKey: string
      newAgentId: string
      untilTaskCount?: number
      titleSuffix?: string
      sourceSessionId?: string
    }) => ipcRenderer.invoke('agent:forkTask', opts) as Promise<{
      newSessionId: string
      newAgentId: string
      sourceUserTask: string
      newRecord: import('@shared/types').AgentRecord
    } | null>,

    // Extract Task From Companion（companion → task 异质转化）：从 companion 关系线
    // 抽取一段开新任务。与 forkTask 的区别：源是 N 条 record 合并的关系线，不是单条会话。
    // anchorTaskIndex = 用户点的 group 在合并视图里的 0-based 索引；后端以此为锚向前取
    // 「同天 + 6h 跨夜连续」的 task 集合作为新任务上下文（最多 10 段兜底）。
    extractTaskFromCompanion: (opts: {
      newAgentId: string
      anchorTaskIndex?: number
      anchorTaskStepId?: string
      titleSuffix?: string
      sourceSteps?: import('@shared/types').AgentStepRecord[]
    }) => ipcRenderer.invoke('agent:extractTaskFromCompanion', opts) as Promise<{
      newSessionId: string
      newAgentId: string
      sourceUserTask: string
      newRecord: import('@shared/types').AgentRecord
    } | null>,

    // 清空指定终端的任务历史记忆（用于"清空对话"功能）
    clearHistory: (ptyId: string) => ipcRenderer.invoke('agent:clearHistory', ptyId) as Promise<void>,

    /** 终端重连后同步运行中 Agent 的默认操作 ptyId（agentKey=tabId） */
    remapPtyId: (agentKey: string, oldPtyId: string, newPtyId: string) =>
      ipcRenderer.invoke('agent:remapPtyId', agentKey, oldPtyId, newPtyId) as Promise<boolean>,

    // 更新 Agent 配置（如执行模式、超时时间、模型配置，使用 ptyId）
    updateConfig: (ptyId: string, config: { executionMode?: ExecutionMode; commandTimeout?: number; profileId?: string }) =>
      ipcRenderer.invoke('agent:updateConfig', ptyId, config) as Promise<boolean>,

    // 添加用户补充消息（Agent 执行过程中，使用 ptyId）
    addMessage: (
      ptyId: string,
      message: string,
      attachments?: import('@shared/types').AttachmentInfo[],
      documentContext?: string,
      images?: string[],
      workbenchContext?: import('@shared/types').WorkbenchContext,
      silent?: boolean
    ) =>
      ipcRenderer.invoke('agent:addMessage', ptyId, message, attachments, documentContext, images, workbenchContext, silent) as Promise<boolean>,

    // 获取执行阶段状态（用于智能打断判断，使用 ptyId）
    getExecutionPhase: (ptyId: string) =>
      ipcRenderer.invoke('agent:getExecutionPhase', ptyId) as Promise<{
        phase: 'thinking' | 'executing_command' | 'writing_file' | 'waiting' | 'confirming' | 'idle'
        currentToolName?: string
        canInterrupt: boolean
        interruptWarning?: string
      } | null>,

    // 监听 Agent 步骤更新（携带 ptyId 用于可靠匹配 tab）
    onStep: (callback: (data: { agentId: string; ptyId?: string; step: AgentStep }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; ptyId?: string; step: AgentStep }) => callback(data)
      ipcRenderer.on('agent:step', handler)
      return () => {
        ipcRenderer.removeListener('agent:step', handler)
      }
    },

    // 监听 Agent 开始运行（IM/WebChat 等外部入口触发时同步桌面 tab isRunning）
    onRunning: (callback: (data: { agentId: string; ptyId?: string; userTask: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; ptyId?: string; userTask: string }) => callback(data)
      ipcRenderer.on('agent:running', handler)
      return () => {
        ipcRenderer.removeListener('agent:running', handler)
      }
    },

    // 监听 Agent 步骤移除（后端撤销了临时步骤，前端同步清除）
    onStepRemoved: (callback: (data: { agentId: string; ptyId?: string; stepId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; ptyId?: string; stepId: string }) => callback(data)
      ipcRenderer.on('agent:stepRemoved', handler)
      return () => {
        ipcRenderer.removeListener('agent:stepRemoved', handler)
      }
    },

    // 监听会话级上下文栏快照（与 step 解耦）
    onContextBar: (callback: (data: { agentId: string; ptyId?: string; contextBar: import('@shared/types').AgentContextBar }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; ptyId?: string; contextBar: import('@shared/types').AgentContextBar }) => callback(data)
      ipcRenderer.on('agent:contextBar', handler)
      return () => {
        ipcRenderer.removeListener('agent:contextBar', handler)
      }
    },

    onModelFailover: (callback: (data: {
      agentId: string
      ptyId?: string
      notice: { fromId: string; fromName: string; usedId: string; usedName: string }
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        agentId: string
        ptyId?: string
        notice: { fromId: string; fromName: string; usedId: string; usedName: string }
      }) => callback(data)
      ipcRenderer.on('agent:modelFailover', handler)
      return () => {
        ipcRenderer.removeListener('agent:modelFailover', handler)
      }
    },

    // 监听需要确认的工具调用（携带 ptyId 用于可靠匹配 tab）
    onNeedConfirm: (callback: (data: PendingConfirmation & { ptyId?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: PendingConfirmation & { ptyId?: string }) => callback(data)
      ipcRenderer.on('agent:needConfirm', handler)
      return () => {
        ipcRenderer.removeListener('agent:needConfirm', handler)
      }
    },

    // 监听安全输入请求（Agent 需要用户通过安全输入框填写 API Key 等）
    onNeedSecureInput: (callback: (data: import('@shared/types').PendingSecureInput & { ptyId?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: import('@shared/types').PendingSecureInput & { ptyId?: string }) => callback(data)
      ipcRenderer.on('agent:needSecureInput', handler)
      return () => {
        ipcRenderer.removeListener('agent:needSecureInput', handler)
      }
    },

    // 监听确认已被其他渠道处理（如 IM 端确认后通知桌面清除确认框）
    onConfirmResolved: (callback: (data: { agentId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string }) => callback(data)
      ipcRenderer.on('agent:confirmResolved', handler)
      return () => {
        ipcRenderer.removeListener('agent:confirmResolved', handler)
      }
    },

    // 监听 Agent 完成（携带 ptyId 用于可靠匹配 tab，可能附带未处理的用户消息与羁绊里程碑）
    onComplete: (callback: (data: {
      agentId: string
      ptyId?: string
      result: string
      pendingUserMessages?: string[]
      aborted?: boolean
      newBondMilestones?: string[]
      bondMetrics?: BondMetrics
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        agentId: string
        ptyId?: string
        result: string
        pendingUserMessages?: string[]
        aborted?: boolean
        newBondMilestones?: string[]
        bondMetrics?: BondMetrics
      }) => callback(data)
      ipcRenderer.on('agent:complete', handler)
      return () => {
        ipcRenderer.removeListener('agent:complete', handler)
      }
    },

    // 监听 Agent 错误（携带 ptyId 用于可靠匹配 tab）
    onError: (callback: (data: { agentId: string; ptyId?: string; error: string; aborted?: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; ptyId?: string; error: string; aborted?: boolean }) => callback(data)
      ipcRenderer.on('agent:error', handler)
      return () => {
        ipcRenderer.removeListener('agent:error', handler)
      }
    }
  },

  allowlist: {
    // NOTE: 返回类型须与 built-in-rules-view.ts 的 BuiltInRulesView 保持同步；
    // preload 不能直接 import main 进程模块，故在此手写镜像。
    getBuiltInRules: () => ipcRenderer.invoke('allowlist:getBuiltInRules') as Promise<{
      argvCommands: Array<{
        cmd: string
        baseLevel: import('@shared/types/agent').RiskLevel
        safeFlags: string[]
        pathMode: 'all' | 'fixed' | 'none'
        writesTo: boolean
      }>
      hardBlockedPaths: {
        systemPatterns: Array<{
          description: string
          severity: 'critical' | 'hardened'
        }>
        devNullExemptions: string[]
        userDataRoot: string
        userDataAllowed: string[]
        userDataReadOnly: string[]
      }
      workspaceZones: {
        workspaceRoot: string
        free: string[]
        protectedDirs: string[]
        protectedFiles: string[]
      }
    }>,
  },

  commandRules: {
    list: () => ipcRenderer.invoke('commandRules:list') as Promise<Array<{
      cmd: string
      baseLevel: import('@shared/types/agent').RiskLevel
      writesTo: boolean
      pathMode: 'all' | 'fixed' | 'none'
      safeFlags: string[]
    }>>,
    upsert: (payload: {
      cmd: string
      baseLevel: import('@shared/types/agent').RiskLevel
      writesTo?: boolean
      pathMode?: 'all' | 'fixed' | 'none'
      safeFlags?: string | string[]
    }) => ipcRenderer.invoke('commandRules:upsert', payload) as Promise<
      | { ok: true; rule: {
          cmd: string
          baseLevel: import('@shared/types/agent').RiskLevel
          writesTo: boolean
          pathMode: 'all' | 'fixed' | 'none'
          safeFlags: string[]
        } }
      | { ok: false; error: string }
    >,
    remove: (cmd: string) => ipcRenderer.invoke('commandRules:remove', cmd) as Promise<boolean>,
    clear: () => ipcRenderer.invoke('commandRules:clear') as Promise<boolean>,
  },

  // 智能巡检协调器
  orchestrator: {
    // 启动智能巡检任务
    start: (task: string, config?: {
      maxParallelWorkers?: number
      workerTimeout?: number
      autoCloseTerminals?: boolean
      confirmStrategy?: 'cautious' | 'batch' | 'free'
      profileId?: string
    }) => ipcRenderer.invoke('orchestrator:start', task, config) as Promise<string>,

    // 停止智能巡检任务
    stop: (orchestratorId: string) => ipcRenderer.invoke('orchestrator:stop', orchestratorId) as Promise<void>,

    // 获取可用主机列表
    listHosts: () => ipcRenderer.invoke('orchestrator:listHosts') as Promise<Array<{
      hostId: string
      name: string
      host: string
      port: number
      username: string
      group?: string
      groupId?: string
      tags?: string[]
    }>>,

    // 响应批量确认
    batchConfirmResponse: (
      orchestratorId: string,
      action: 'cancel' | 'current' | 'all',
      selectedTerminals?: string[]
    ) => ipcRenderer.invoke('orchestrator:batchConfirmResponse', orchestratorId, action, selectedTerminals) as Promise<void>,

    // 获取协调器状态
    getStatus: (orchestratorId: string) => ipcRenderer.invoke('orchestrator:getStatus', orchestratorId),

    // 监听协调器消息
    onMessage: (callback: (data: {
      orchestratorId: string
      message: {
        id: string
        type: 'user' | 'agent' | 'system' | 'progress'
        content: string
        timestamp: number
      }
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('orchestrator:message', handler)
      return () => {
        ipcRenderer.removeListener('orchestrator:message', handler)
      }
    },

    // 监听 Worker 状态更新
    onWorkerUpdate: (callback: (data: {
      orchestratorId: string
      worker: {
        terminalId: string
        hostId: string
        hostName: string
        status: 'connecting' | 'idle' | 'running' | 'completed' | 'failed' | 'timeout'
        currentTask?: string
        result?: string
        error?: string
      }
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('orchestrator:workerUpdate', handler)
      return () => {
        ipcRenderer.removeListener('orchestrator:workerUpdate', handler)
      }
    },

    // 监听计划更新
    onPlanUpdate: (callback: (data: {
      orchestratorId: string
      plan: {
        id: string
        title: string
        steps: Array<{
          id: string
          title: string
          status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
          terminalId?: string
          terminalName?: string
          result?: string
        }>
        createdAt: number
        updatedAt: number
      }
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('orchestrator:planUpdate', handler)
      return () => {
        ipcRenderer.removeListener('orchestrator:planUpdate', handler)
      }
    },

    // 监听需要批量确认
    onNeedBatchConfirm: (callback: (data: {
      orchestratorId: string
      command: string
      riskLevel: 'safe' | 'moderate' | 'dangerous' | 'blocked'
      targetTerminals: Array<{
        terminalId: string
        terminalName: string
        selected: boolean
      }>
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('orchestrator:needBatchConfirm', handler)
      return () => {
        ipcRenderer.removeListener('orchestrator:needBatchConfirm', handler)
      }
    },

    // 监听任务完成
    onComplete: (callback: (data: {
      orchestratorId: string
      result: {
        totalCount: number
        successCount: number
        failedCount: number
        results: Array<{
          terminalId: string
          terminalName: string
          success: boolean
          result?: string
          error?: string
        }>
      }
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('orchestrator:complete', handler)
      return () => {
        ipcRenderer.removeListener('orchestrator:complete', handler)
      }
    },

    // 监听任务错误
    onError: (callback: (data: { orchestratorId: string; error: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { orchestratorId: string; error: string }) => callback(data)
      ipcRenderer.on('orchestrator:error', handler)
      return () => {
        ipcRenderer.removeListener('orchestrator:error', handler)
      }
    }
  },

  // 历史记录操作
  history: {
    // 保存 Agent 记录
    saveAgentRecord: (record: {
      id: string
      timestamp: number
      terminalId: string
      terminalType: 'local' | 'ssh'
      sshHost?: string
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
    }) => ipcRenderer.invoke('history:saveAgentRecord', record),

    // 获取 Agent 记录
    getAgentRecords: (startDate?: string, endDate?: string) => 
      ipcRenderer.invoke('history:getAgentRecords', startDate, endDate),

    getRecentAgentRecords: (limit?: number, excludeWakeup?: boolean) =>
      ipcRenderer.invoke('history:getRecentAgentRecords', limit, excludeWakeup),

    listAgentSummaries: (excludeWakeup?: boolean) =>
      ipcRenderer.invoke('history:listAgentSummaries', excludeWakeup) as Promise<
        Array<{
          id: string
          timestamp: number
          duration: number
          userTask: string
          terminalType: 'local' | 'ssh'
          agentKey?: string
          sshHost?: string
          status: 'completed' | 'failed' | 'aborted'
        }>
      >,

    exportHugeJsonlLine: (payload: { sourceFile: string; sourceLine: number }) =>
      ipcRenderer.invoke('history:exportHugeJsonlLine', payload) as Promise<{
        success: boolean
        canceled?: boolean
        error?: string
        bytes?: number
        path?: string
      }>,

    /** 任务侧栏短标题：首条消息后异步生成，失败返回 null */
    generateConversationTitle: (sessionId: string, userMessage: string, profileId?: string) =>
      ipcRenderer.invoke('history:generateConversationTitle', sessionId, userMessage, profileId) as Promise<string | null>,

    /** 设置会话展示标题（写入会话记录，非 config overlay） */
    setConversationTitle: (sessionId: string, title: string, options?: { locked?: boolean }) =>
      ipcRenderer.invoke('history:setConversationTitle', sessionId, title, options) as Promise<boolean>,

    onConversationTitle: (callback: (payload: { sessionId: string; title: string }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { sessionId: string; title: string }
      ) => callback(payload)
      ipcRenderer.on('history:conversationTitle', handler)
      return () => { ipcRenderer.removeListener('history:conversationTitle', handler) }
    },

    searchAgentRecords: (options: {
      keyword?: string
      startDate?: string
      endDate?: string
      limit?: number
      excludeWakeup?: boolean
      titleOnly?: boolean
      requestId?: string
    }) =>
      ipcRenderer.invoke('history:searchAgentRecords', options) as Promise<{
        records: Array<{
          id: string
          timestamp: number
          terminalId: string
          terminalType: 'local' | 'ssh'
          sshHost?: string
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
        }>
        totalMatched: number
        hasMore: boolean
      }>,
    onSearchMatch: (callback: (payload: {
      requestId: string
      summary: import('@shared/types').AgentHistorySummary
    }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { requestId: string; summary: import('@shared/types').AgentHistorySummary }
      ) => callback(payload)
      ipcRenderer.on('history:searchMatch', handler)
      return () => { ipcRenderer.removeListener('history:searchMatch', handler) }
    },
    abortSearchAgentRecords: () =>
      ipcRenderer.invoke('history:abortSearchAgentRecords') as Promise<void>,

    // 按 ID 获取单条 Agent 记录
    getAgentRecordById: (id: string) =>
      ipcRenderer.invoke('history:getAgentRecordById', id),

    // 取某 agentKey 最近 N 条完整会话记录（联络常驻 tab 合并恢复历史对话）
    getRecentByAgentKey: (agentKey: string, limit?: number) =>
      ipcRenderer.invoke('history:getRecentByAgentKey', agentKey, limit),

    // 取 companion 关系线的合并视图 record（最近 N 条 companion record 合并后的展示用 record）。
    // 合并逻辑在后端 Companion 领域对象，前端不再自拼。
    getCompanionMergedView: () =>
      ipcRenderer.invoke('history:getCompanionMergedView') as Promise<import('@shared/types').AgentRecord | undefined>,

    deleteAgentRecord: (id: string) =>
      ipcRenderer.invoke('history:deleteAgentRecord', id) as Promise<boolean>,

    saveArtifacts: (recordId: string, artifacts: import('@shared/types').CanvasArtifact[]) =>
      ipcRenderer.invoke('history:saveArtifacts', recordId, artifacts) as Promise<void>,

    // 获取数据目录路径
    getDataPath: () => ipcRenderer.invoke('history:getDataPath') as Promise<string>,

    // 获取存储统计
    getStorageStats: () => ipcRenderer.invoke('history:getStorageStats') as Promise<{
      chatFiles: number
      agentFiles: number
      agentSessions: number
      totalSize: number
      oldestRecord?: string
      newestRecord?: string
    }>,

    // 获取 Token 用量统计
    getTokenUsageStats: () => ipcRenderer.invoke('history:getTokenUsageStats') as Promise<{
      total: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }
      today: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }
      last7Days: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }
      last30Days: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }
      daily: Array<{ date: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }>
    }>,

    // 清理旧记录
    cleanup: (daysToKeep: number) => ipcRenderer.invoke('history:cleanup', daysToKeep) as Promise<{
      chatDeleted: number
      agentDeleted: number
    }>,

    // 在文件管理器中打开数据目录
    openDataFolder: () => ipcRenderer.invoke('history:openDataFolder')
  },

  // 完整数据备份 / 恢复（整包 userData）
  dataBackup: {
    export: () => ipcRenderer.invoke('dataBackup:export') as Promise<{
      success: boolean
      canceled?: boolean
      cancelReason?: 'dialog' | 'overwrite' | 'export'
      path?: string
      files?: number
      totalBytes?: number
      error?: string
    }>,
    cancel: () => ipcRenderer.invoke('dataBackup:cancel') as Promise<{ ok: boolean }>,
    requestRestore: () => ipcRenderer.invoke('dataBackup:requestRestore') as Promise<{
      success: boolean
      canceled?: boolean
      error?: string
    }>,
    onProgress: (callback: (data: {
      pct: number
      file: string
      bytes: number
      totalBytes: number
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        pct: number
        file: string
        bytes: number
        totalBytes: number
      }) => callback(data)
      ipcRenderer.on('dataBackup:progress', handler)
      return () => { ipcRenderer.removeListener('dataBackup:progress', handler) }
    },
  },

  // 数据目录自定义 / 迁移
  dataDir: {
    getInfo: () => ipcRenderer.invoke('dataDir:getInfo') as Promise<{
      current: string
      default: string
      isCustom: boolean
      lastError?: string
    }>,
    hasRunningAgents: () => ipcRenderer.invoke('dataDir:hasRunningAgents') as Promise<boolean>,
    pickTarget: () => ipcRenderer.invoke('dataDir:pickTarget') as Promise<{
      canceled: boolean
      target?: string
      nonEmpty?: boolean
    }>,
    migrate: (target: string) => ipcRenderer.invoke('dataDir:migrate', target) as Promise<{ ok: boolean; error?: string }>,
    reset: () => ipcRenderer.invoke('dataDir:reset') as Promise<{ ok: boolean; error?: string }>
  },

  // macOS：安装 / 卸载 PATH 上的 sailfish 命令
  shellCli: {
    status: () => ipcRenderer.invoke('shellCli:status') as Promise<{
      installed: boolean
      shimPath: string | null
      target: string | null
      binDir: string
      mode: 'packaged' | 'development'
    }>,
    install: () => ipcRenderer.invoke('shellCli:install') as Promise<{
      ok: boolean
      shimPath?: string
      binDir?: string
      error?: string
      pathHint?: boolean
    }>,
    uninstall: () => ipcRenderer.invoke('shellCli:uninstall') as Promise<{ ok: boolean; error?: string }>
  },

  // 主机档案操作
  hostProfile: {
    // 获取主机档案
    get: (hostId: string) => ipcRenderer.invoke('hostProfile:get', hostId) as Promise<{
      hostId: string
      hostname: string
      username: string
      os: string
      osVersion: string
      shell: string
      packageManager?: string
      installedTools: string[]
      homeDir?: string
      currentDir?: string
      notes: string[]
      lastProbed: number
      lastUpdated: number
    } | null>,

    // 获取所有主机档案
    getAll: () => ipcRenderer.invoke('hostProfile:getAll'),

    // 更新主机档案
    update: (hostId: string, updates: object) => ipcRenderer.invoke('hostProfile:update', hostId, updates),

    // 添加笔记
    addNote: (hostId: string, note: string) => ipcRenderer.invoke('hostProfile:addNote', hostId, note),

    // 删除主机档案
    delete: (hostId: string) => ipcRenderer.invoke('hostProfile:delete', hostId),

    // 获取探测命令
    getProbeCommands: (os: string) => ipcRenderer.invoke('hostProfile:getProbeCommands', os) as Promise<string[]>,

    // 解析探测结果
    parseProbeOutput: (output: string, hostId?: string) => ipcRenderer.invoke('hostProfile:parseProbeOutput', output, hostId),

    // 生成主机 ID
    generateHostId: (type: 'local' | 'ssh', sshHost?: string, sshUser?: string) => 
      ipcRenderer.invoke('hostProfile:generateHostId', type, sshHost, sshUser) as Promise<string>,

    // 检查是否需要探测
    needsProbe: (hostId: string) => ipcRenderer.invoke('hostProfile:needsProbe', hostId) as Promise<boolean>,

    // 后台探测本地主机（不在终端显示）
    probeLocal: () => ipcRenderer.invoke('hostProfile:probeLocal') as Promise<{
      hostId: string
      hostname: string
      username: string
      os: string
      osVersion: string
      shell: string
      packageManager?: string
      installedTools: string[]
      notes: string[]
      lastProbed: number
      lastUpdated: number
    }>,

    // 生成主机上下文
    generateContext: (hostId: string) => ipcRenderer.invoke('hostProfile:generateContext', hostId) as Promise<string>,
    
    // SSH 主机探测
    probeSsh: (sshId: string, hostId: string) => ipcRenderer.invoke('hostProfile:probeSsh', sshId, hostId) as Promise<{
      hostId: string
      hostname: string
      username: string
      os: string
      osVersion: string
      shell: string
      packageManager?: string
      installedTools: string[]
      homeDir?: string
      currentDir?: string
      notes: string[]
      lastProbed: number
      lastUpdated: number
    } | null>
  },

  // 文档解析操作
  document: {
    // 选择文件
    selectFiles: () => ipcRenderer.invoke('document:selectFiles') as Promise<{
      canceled: boolean
      files: Array<{
        name: string
        path: string
        size: number
      }>
    }>,

    // 解析单个文档
    parse: (file: {
      name: string
      path: string
      size: number
      mimeType?: string
    }, options?: {
      maxFileSize?: number
      maxTextLength?: number
      extractMetadata?: boolean
      extractImages?: boolean
    }) => ipcRenderer.invoke('document:parse', file, options) as Promise<{
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
    }>,

    // 批量解析文档
    parseMultiple: (files: Array<{
      name: string
      path: string
      size: number
      mimeType?: string
    }>, options?: {
      maxFileSize?: number
      maxTextLength?: number
      extractMetadata?: boolean
      extractImages?: boolean
      requestId?: string
    }) => ipcRenderer.invoke('document:parseMultiple', files, options) as Promise<Array<{
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
    }>>,

    onParseProgress: (callback: (progress: DocumentParseProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: DocumentParseProgress) => callback(progress)
      ipcRenderer.on('document:parseProgress', handler)
      return () => {
        ipcRenderer.removeListener('document:parseProgress', handler)
      }
    },

    // 格式化为 AI 上下文
    formatAsContext: (docs: Array<{
      filename: string
      fileType: string
      content: string
      fileSize: number
      parseTime: number
      pageCount?: number
      metadata?: Record<string, string>
      error?: string
    }>) => ipcRenderer.invoke('document:formatAsContext', docs) as Promise<string>,

    // 生成文档摘要
    generateSummary: (doc: {
      filename: string
      fileType: string
      content: string
      fileSize: number
      parseTime: number
      pageCount?: number
      error?: string
    }) => ipcRenderer.invoke('document:generateSummary', doc) as Promise<string>,

    // 检查解析能力
    checkCapabilities: () => ipcRenderer.invoke('document:checkCapabilities') as Promise<{
      pdf: boolean
      docx: boolean
      doc: boolean
      text: boolean
    }>,

    // 获取支持的文件类型
    getSupportedTypes: () => ipcRenderer.invoke('document:getSupportedTypes') as Promise<Array<{
      extension: string
      description: string
      available: boolean
    }>>
  },

  // SFTP 操作
  sftp: {
    // 连接
    connect: (sessionId: string, config: SftpConfig) =>
      ipcRenderer.invoke('sftp:connect', sessionId, config) as Promise<{ success: boolean; error?: string }>,

    // 断开连接
    disconnect: (sessionId: string) =>
      ipcRenderer.invoke('sftp:disconnect', sessionId),

    // 检查连接
    hasSession: (sessionId: string) =>
      ipcRenderer.invoke('sftp:hasSession', sessionId) as Promise<boolean>,

    // 列出目录
    list: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:list', sessionId, remotePath) as Promise<{
        success: boolean
        data?: SftpFileInfo[]
        resolvedPath?: string  // 解析后的实际路径（处理 ~ 等）
        error?: string
      }>,

    // 获取当前工作目录
    pwd: (sessionId: string) =>
      ipcRenderer.invoke('sftp:pwd', sessionId) as Promise<{
        success: boolean
        data?: string
        error?: string
      }>,

    // 检查路径是否存在
    exists: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:exists', sessionId, remotePath) as Promise<{
        success: boolean
        data?: false | 'd' | '-' | 'l'
        error?: string
      }>,

    // 获取文件信息
    stat: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:stat', sessionId, remotePath) as Promise<{
        success: boolean
        data?: object
        error?: string
      }>,

    // 上传文件
    upload: (sessionId: string, localPath: string, remotePath: string, transferId: string) =>
      ipcRenderer.invoke('sftp:upload', sessionId, localPath, remotePath, transferId) as Promise<{
        success: boolean
        error?: string
      }>,

    // 下载文件
    download: (sessionId: string, remotePath: string, localPath: string, transferId: string) =>
      ipcRenderer.invoke('sftp:download', sessionId, remotePath, localPath, transferId) as Promise<{
        success: boolean
        error?: string
      }>,

    // 上传目录
    uploadDir: (sessionId: string, localDir: string, remoteDir: string) =>
      ipcRenderer.invoke('sftp:uploadDir', sessionId, localDir, remoteDir) as Promise<{
        success: boolean
        error?: string
      }>,

    // 下载目录
    downloadDir: (sessionId: string, remoteDir: string, localDir: string) =>
      ipcRenderer.invoke('sftp:downloadDir', sessionId, remoteDir, localDir) as Promise<{
        success: boolean
        error?: string
      }>,

    // 创建目录
    mkdir: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:mkdir', sessionId, remotePath) as Promise<{
        success: boolean
        error?: string
      }>,

    // 删除文件
    delete: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:delete', sessionId, remotePath) as Promise<{
        success: boolean
        error?: string
      }>,

    // 删除目录
    rmdir: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:rmdir', sessionId, remotePath) as Promise<{
        success: boolean
        error?: string
      }>,

    // 重命名/移动
    rename: (sessionId: string, oldPath: string, newPath: string) =>
      ipcRenderer.invoke('sftp:rename', sessionId, oldPath, newPath) as Promise<{
        success: boolean
        error?: string
      }>,

    // 修改权限
    chmod: (sessionId: string, remotePath: string, mode: string | number) =>
      ipcRenderer.invoke('sftp:chmod', sessionId, remotePath, mode) as Promise<{
        success: boolean
        error?: string
      }>,

    // 读取文本文件
    readFile: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:readFile', sessionId, remotePath) as Promise<{
        success: boolean
        data?: string
        error?: string
      }>,

    // 写入文本文件
    writeFile: (sessionId: string, remotePath: string, content: string) =>
      ipcRenderer.invoke('sftp:writeFile', sessionId, remotePath, content) as Promise<{
        success: boolean
        error?: string
      }>,

    // 获取传输列表
    getTransfers: () =>
      ipcRenderer.invoke('sftp:getTransfers') as Promise<TransferProgress[]>,

    // 选择本地文件
    selectLocalFiles: () =>
      ipcRenderer.invoke('sftp:selectLocalFiles') as Promise<{
        canceled: boolean
        files: Array<{
          name: string
          path: string
          size: number
          isDirectory: boolean
        }>
      }>,

    // 选择本地目录
    selectLocalDirectory: (options?: { title?: string; forSave?: boolean }) =>
      ipcRenderer.invoke('sftp:selectLocalDirectory', options) as Promise<{
        canceled: boolean
        path: string
      }>,

    // 选择保存路径
    selectSavePath: (defaultName: string) =>
      ipcRenderer.invoke('sftp:selectSavePath', defaultName) as Promise<{
        canceled: boolean
        path: string
      }>,

    // 监听传输开始
    onTransferStart: (callback: (progress: TransferProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: TransferProgress) => callback(progress)
      ipcRenderer.on('sftp:transfer-start', handler)
      return () => {
        ipcRenderer.removeListener('sftp:transfer-start', handler)
      }
    },

    // 监听传输进度
    onTransferProgress: (callback: (progress: TransferProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: TransferProgress) => callback(progress)
      ipcRenderer.on('sftp:transfer-progress', handler)
      return () => {
        ipcRenderer.removeListener('sftp:transfer-progress', handler)
      }
    },

    // 监听传输完成
    onTransferComplete: (callback: (progress: TransferProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: TransferProgress) => callback(progress)
      ipcRenderer.on('sftp:transfer-complete', handler)
      return () => {
        ipcRenderer.removeListener('sftp:transfer-complete', handler)
      }
    },

    // 监听传输错误
    onTransferError: (callback: (progress: TransferProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: TransferProgress) => callback(progress)
      ipcRenderer.on('sftp:transfer-error', handler)
      return () => {
        ipcRenderer.removeListener('sftp:transfer-error', handler)
      }
    },

    // 取消传输
    cancelTransfer: (transferId: string) =>
      ipcRenderer.invoke('sftp:cancelTransfer', transferId) as Promise<{
        success: boolean
        error?: string
      }>,

    // 监听传输取消
    onTransferCancelled: (callback: (progress: TransferProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: TransferProgress) => callback(progress)
      ipcRenderer.on('sftp:transfer-cancelled', handler)
      return () => {
        ipcRenderer.removeListener('sftp:transfer-cancelled', handler)
      }
    }
  },

  // MCP 操作
  mcp: {
    // 获取服务器配置列表
    getServers: () =>
      ipcRenderer.invoke('mcp:getServers') as Promise<McpServerConfig[]>,

    // 保存服务器配置列表
    setServers: (servers: McpServerConfig[]) =>
      ipcRenderer.invoke('mcp:setServers', servers),

    // 添加服务器
    addServer: (server: McpServerConfig) =>
      ipcRenderer.invoke('mcp:addServer', server),

    // 更新服务器
    updateServer: (server: McpServerConfig) =>
      ipcRenderer.invoke('mcp:updateServer', server),

    // 删除服务器
    deleteServer: (id: string) =>
      ipcRenderer.invoke('mcp:deleteServer', id),

    // 连接到服务器
    connect: (config: McpServerConfig) =>
      ipcRenderer.invoke('mcp:connect', config) as Promise<{
        success: boolean
        error?: string
      }>,

    // 断开连接
    disconnect: (serverId: string) =>
      ipcRenderer.invoke('mcp:disconnect', serverId),

    // 测试连接
    testConnection: (config: McpServerConfig) =>
      ipcRenderer.invoke('mcp:testConnection', config) as Promise<{
        success: boolean
        toolCount?: number
        resourceCount?: number
        promptCount?: number
        tools?: Array<{ name: string; title?: string; description: string }>
        error?: string
      }>,

    /** AI 生成 whenToUse 草稿（须用户确认后写入） */
    suggestWhenToUse: (input: {
      name: string
      tools: Array<{ name: string; title?: string; description?: string }>
    }) =>
      ipcRenderer.invoke('mcp:suggestWhenToUse', input) as Promise<{
        success: boolean
        whenToUse?: string
        error?: string
      }>,

    // 获取服务器状态列表
    getServerStatuses: () =>
      ipcRenderer.invoke('mcp:getServerStatuses') as Promise<McpServerStatus[]>,

    // 获取所有工具
    getAllTools: () =>
      ipcRenderer.invoke('mcp:getAllTools') as Promise<McpTool[]>,

    // 获取所有资源
    getAllResources: () =>
      ipcRenderer.invoke('mcp:getAllResources') as Promise<McpResource[]>,

    // 获取所有提示模板
    getAllPrompts: () =>
      ipcRenderer.invoke('mcp:getAllPrompts') as Promise<McpPrompt[]>,

    // 调用工具
    callTool: (serverId: string, toolName: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke('mcp:callTool', serverId, toolName, args) as Promise<{
        success: boolean
        content?: string
        error?: string
      }>,

    // 读取资源
    readResource: (serverId: string, uri: string) =>
      ipcRenderer.invoke('mcp:readResource', serverId, uri) as Promise<{
        success: boolean
        content?: string
        mimeType?: string
        error?: string
      }>,

    // 获取提示模板
    getPrompt: (serverId: string, promptName: string, args?: Record<string, string>) =>
      ipcRenderer.invoke('mcp:getPrompt', serverId, promptName, args) as Promise<{
        success: boolean
        messages?: Array<{ role: string; content: string }>
        error?: string
      }>,

    // 刷新服务器
    refreshServer: (serverId: string) =>
      ipcRenderer.invoke('mcp:refreshServer', serverId) as Promise<{
        success: boolean
        error?: string
      }>,

    // 检查是否已连接
    isConnected: (serverId: string) =>
      ipcRenderer.invoke('mcp:isConnected', serverId) as Promise<boolean>,

    // 连接所有启用的服务器
    connectEnabledServers: () =>
      ipcRenderer.invoke('mcp:connectEnabledServers') as Promise<Array<{
        id: string
        success: boolean
        error?: string
      }>>,

    // 断开所有连接
    disconnectAll: () =>
      ipcRenderer.invoke('mcp:disconnectAll'),

    // 监听服务器连接事件
    onConnected: (callback: (serverId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, serverId: string) => callback(serverId)
      ipcRenderer.on('mcp:connected', handler)
      return () => {
        ipcRenderer.removeListener('mcp:connected', handler)
      }
    },

    // 监听服务器断开事件
    onDisconnected: (callback: (serverId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, serverId: string) => callback(serverId)
      ipcRenderer.on('mcp:disconnected', handler)
      return () => {
        ipcRenderer.removeListener('mcp:disconnected', handler)
      }
    },

    // 监听服务器错误事件
    onError: (callback: (data: { serverId: string; error?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { serverId: string; error?: string }) => callback(data)
      ipcRenderer.on('mcp:error', handler)
      return () => {
        ipcRenderer.removeListener('mcp:error', handler)
      }
    },

    // 监听服务器刷新事件
    onRefreshed: (callback: (serverId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, serverId: string) => callback(serverId)
      ipcRenderer.on('mcp:refreshed', handler)
      return () => {
        ipcRenderer.removeListener('mcp:refreshed', handler)
      }
    }
  },

  // 插件系统
  plugin: {
    list: () =>
      ipcRenderer.invoke('plugin:list') as Promise<Array<{ id: string; name?: string; description?: string; version?: string; enabled: boolean; toolCount: number }>>,
    enable: (id: string) =>
      ipcRenderer.invoke('plugin:enable', id) as Promise<boolean>,
    disable: (id: string) =>
      ipcRenderer.invoke('plugin:disable', id) as Promise<boolean>,
    install: (spec: string) =>
      ipcRenderer.invoke('plugin:install', spec) as Promise<{ success: boolean; pluginId?: string; error?: string }>,
    uninstall: (pluginId: string) =>
      ipcRenderer.invoke('plugin:uninstall', pluginId) as Promise<{ success: boolean; error?: string }>,
    update: (packageName: string) =>
      ipcRenderer.invoke('plugin:update', packageName) as Promise<{ success: boolean; error?: string }>,
    getConfig: (id: string) =>
      ipcRenderer.invoke('plugin:getConfig', id) as Promise<Record<string, unknown>>,
    setConfig: (id: string, config: Record<string, unknown>) =>
      ipcRenderer.invoke('plugin:setConfig', id, config) as Promise<void>,
  },

  // 内置技能
  builtinSkill: {
    list: () =>
      ipcRenderer.invoke('builtinSkill:list') as Promise<Array<{ id: string; name: string; description: string; enabled: boolean }>>,
    toggle: (skillId: string, enabled: boolean) =>
      ipcRenderer.invoke('builtinSkill:toggle', skillId, enabled) as Promise<boolean>
  },

  // 用户技能操作
  userSkill: {
    // 获取所有技能列表
    list: () =>
      ipcRenderer.invoke('userSkill:list') as Promise<UserSkill[]>,

    // 刷新技能列表
    refresh: () =>
      ipcRenderer.invoke('userSkill:refresh') as Promise<UserSkill[]>,

    // 启用/禁用技能
    toggle: (skillId: string, enabled: boolean) =>
      ipcRenderer.invoke('userSkill:toggle', skillId, enabled) as Promise<boolean>,

    // 打开技能目录
    openFolder: () =>
      ipcRenderer.invoke('userSkill:openFolder') as Promise<void>,

    // 获取技能完整内容
    getContent: (skillId: string) =>
      ipcRenderer.invoke('userSkill:getContent', skillId) as Promise<string | null>,

    // 获取技能目录路径
    getSkillsDir: () =>
      ipcRenderer.invoke('userSkill:getSkillsDir') as Promise<string>,

    // 技能 env key 管理
    setEnv: (skillId: string, envName: string, value: string) =>
      ipcRenderer.invoke('skill:setEnv', skillId, envName, value) as Promise<{ success: boolean }>,

    getEnvNames: (skillId: string) =>
      ipcRenderer.invoke('skill:getEnvNames', skillId) as Promise<string[]>,

    deleteEnv: (skillId: string, envName: string) =>
      ipcRenderer.invoke('skill:deleteEnv', skillId, envName) as Promise<{ success: boolean }>,

    getEnvStatus: (skillId: string) =>
      ipcRenderer.invoke('skill:getEnvStatus', skillId) as Promise<Array<{ name: string; configured: boolean }>>,
  },

  // 技能市场
  skillMarket: {
    list: (force?: boolean) =>
      ipcRenderer.invoke('skillMarket:list', force) as Promise<any[]>,

    search: (query: string) =>
      ipcRenderer.invoke('skillMarket:search', query) as Promise<any[]>,

    install: (skillId: string) =>
      ipcRenderer.invoke('skillMarket:install', skillId) as Promise<{ success: boolean; error?: string }>,

    uninstall: (skillId: string) =>
      ipcRenderer.invoke('skillMarket:uninstall', skillId) as Promise<{ success: boolean; error?: string }>,

    update: (skillId: string) =>
      ipcRenderer.invoke('skillMarket:update', skillId) as Promise<{ success: boolean; error?: string }>,

    getRegistryUrl: () =>
      ipcRenderer.invoke('skillMarket:getRegistryUrl') as Promise<string>,

    setRegistryUrl: (url: string) =>
      ipcRenderer.invoke('skillMarket:setRegistryUrl', url) as Promise<void>,

    fetchRegistry: (force?: boolean) =>
      ipcRenderer.invoke('skillMarket:fetchRegistry', force) as Promise<any>,

    preview: (skillId: string, source: string) =>
      ipcRenderer.invoke('skillMarket:preview', skillId, source) as Promise<any>,

    searchClawHub: (query: string) =>
      ipcRenderer.invoke('skillMarket:searchClawHub', query) as Promise<any[]>,
  },

  // 知识库操作
  knowledge: {
    // 初始化
    initialize: () =>
      ipcRenderer.invoke('knowledge:initialize') as Promise<{ success: boolean; error?: string }>,

    // 获取设置
    getSettings: () =>
      ipcRenderer.invoke('knowledge:getSettings') as Promise<{
        enabled: boolean
        embeddingMode: 'local' | 'mcp'
        localModel: 'auto' | 'lite' | 'standard' | 'large'
        embeddingDevice?: 'auto' | 'cpu' | 'gpu' | 'coreml' | 'cuda' | 'dml' | 'webgpu'
        embeddingMcpServerId?: string
        autoSaveUploads: boolean
        chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
        searchTopK: number
        enableRerank: boolean
        enableHostMemory: boolean
        mcpKnowledgeServerId?: string
      }>,

    // 更新设置
    updateSettings: (settings: Partial<{
      enabled: boolean
      embeddingMode: 'local' | 'mcp'
      localModel: 'auto' | 'lite' | 'standard' | 'large'
      embeddingDevice?: 'auto' | 'cpu' | 'gpu' | 'coreml' | 'cuda' | 'dml' | 'webgpu'
      embeddingMcpServerId?: string
      autoSaveUploads: boolean
      chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
      searchTopK: number
      enableRerank: boolean
      enableHostMemory: boolean
      mcpKnowledgeServerId?: string
    }>) =>
      ipcRenderer.invoke('knowledge:updateSettings', settings) as Promise<{ success: boolean; error?: string }>,

    // 添加文档
    addDocument: (doc: {
      filename: string
      fileType: string
      content: string
      fileSize: number
      parseTime: number
      pageCount?: number
      error?: string
    }, options?: {
      hostId?: string
      tags?: string[]
    }) =>
      ipcRenderer.invoke('knowledge:addDocument', doc, options) as Promise<{
        success: boolean
        docId?: string
        error?: string
        duplicate?: boolean
        existingFilename?: string
      }>,

    // 删除文档
    removeDocument: (docId: string) =>
      ipcRenderer.invoke('knowledge:removeDocument', docId) as Promise<{ success: boolean; error?: string }>,

    // 批量删除文档
    removeDocuments: (docIds: string[]) =>
      ipcRenderer.invoke('knowledge:removeDocuments', docIds) as Promise<{ success: boolean; deleted?: number; failed?: number; error?: string }>,

    // 搜索
    search: (query: string, options?: {
      limit?: number
      hostId?: string
      tags?: string[]
      similarity?: number
      enableRerank?: boolean
    }) =>
      ipcRenderer.invoke('knowledge:search', query, options) as Promise<{
        success: boolean
        results: Array<{
          id: string
          docId: string
          content: string
          score: number
          metadata: {
            filename: string
            hostId?: string
            tags: string[]
          }
          source: 'local' | 'mcp'
        }>
        error?: string
      }>,

    // 获取主机相关知识
    getHostKnowledge: (hostId: string) =>
      ipcRenderer.invoke('knowledge:getHostKnowledge', hostId) as Promise<{
        success: boolean
        results: Array<{
          id: string
          docId: string
          content: string
          score: number
          metadata: object
          source: 'local' | 'mcp'
        }>
        error?: string
      }>,

    // 构建 AI 上下文
    buildContext: (query: string, options?: { hostId?: string; maxTokens?: number }) =>
      ipcRenderer.invoke('knowledge:buildContext', query, options) as Promise<{
        success: boolean
        context: string
        error?: string
      }>,

    // 获取所有文档
    getDocuments: () =>
      ipcRenderer.invoke('knowledge:getDocuments') as Promise<Array<{
        id: string
        filename: string
        content: string
        fileSize: number
        fileType: string
        hostId?: string
        tags: string[]
        createdAt: number
        updatedAt: number
        chunkCount: number
      }>>,

    // 获取指定文档
    getDocument: (docId: string) =>
      ipcRenderer.invoke('knowledge:getDocument', docId) as Promise<{
        id: string
        filename: string
        content: string
        fileSize: number
        fileType: string
        hostId?: string
        tags: string[]
        createdAt: number
        updatedAt: number
        chunkCount: number
      } | undefined>,

    // 获取统计信息
    getStats: () =>
      ipcRenderer.invoke('knowledge:getStats') as Promise<{
        success: boolean
        stats?: {
          documentCount: number
          chunkCount: number
          totalSize: number
          lastUpdated?: number
        }
        error?: string
      }>,

    // 清空知识库
    clear: () =>
      ipcRenderer.invoke('knowledge:clear') as Promise<{ success: boolean; error?: string }>,

    // 导出知识库数据
    exportData: () =>
      ipcRenderer.invoke('knowledge:exportData') as Promise<{ success?: boolean; canceled?: boolean; error?: string; path?: string }>,

    // 导入知识库数据
    importData: () =>
      ipcRenderer.invoke('knowledge:importData') as Promise<{ success?: boolean; canceled?: boolean; error?: string; imported?: number }>,

    saveBackupTo: () =>
      ipcRenderer.invoke('knowledge:saveBackupTo') as Promise<{ success?: boolean; canceled?: boolean; error?: string; path?: string; backupPath?: string }>,

    restoreFromFolder: () =>
      ipcRenderer.invoke('knowledge:restoreFromFolder') as Promise<{ success?: boolean; canceled?: boolean; error?: string; backupPath?: string }>,

    // 检查知识库初始化是否完成
    isInitialized: () =>
      ipcRenderer.invoke('knowledge:isInitialized') as Promise<boolean>,

    // 等待知识库初始化完成
    waitInitialized: () =>
      ipcRenderer.invoke('knowledge:waitInitialized') as Promise<boolean>,

    // 检查服务状态（embedding 模型是否加载）
    isReady: () =>
      ipcRenderer.invoke('knowledge:isReady') as Promise<boolean>,

    // 检查是否启用
    isEnabled: () =>
      ipcRenderer.invoke('knowledge:isEnabled') as Promise<boolean>,

    // 获取所有模型
    getModels: () =>
      ipcRenderer.invoke('knowledge:getModels') as Promise<Array<{
        id: 'lite' | 'standard' | 'large'
        name: string
        huggingfaceId: string
        size: number
        dimensions: number
        bundled: boolean
      }>>,

    // 获取模型状态
    getModelStatuses: () =>
      ipcRenderer.invoke('knowledge:getModelStatuses') as Promise<Array<{
        id: 'lite' | 'standard' | 'large'
        available: boolean
        downloading: boolean
        progress?: number
        error?: string
      }>>,

    // 下载模型
    downloadModel: (modelId: 'lite' | 'standard' | 'large') =>
      ipcRenderer.invoke('knowledge:downloadModel', modelId) as Promise<{
        success: boolean
        error?: string
      }>,

    // 切换模型
    switchModel: (modelId: 'lite' | 'standard' | 'large') =>
      ipcRenderer.invoke('knowledge:switchModel', modelId) as Promise<{
        success: boolean
        error?: string
      }>,

    // 监听下载进度
    onDownloadProgress: (callback: (data: {
      modelId: string
      percent: number
      downloaded: number
      total: number
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        modelId: string
        percent: number
        downloaded: number
        total: number
      }) => callback(data)
      ipcRenderer.on('knowledge:downloadProgress', handler)
      return () => {
        ipcRenderer.removeListener('knowledge:downloadProgress', handler)
      }
    },

    // 监听知识库服务就绪事件
    onReady: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('knowledge:ready', handler)
      return () => {
        ipcRenderer.removeListener('knowledge:ready', handler)
      }
    },

    // 监听知识库索引重建事件（模型升级 / 数据损坏 / 索引缺失）
    // payload.cause 区分原因，由前端决定文案
    onUpgrading: (callback: (data: {
      reason: 'vector' | 'bm25' | 'both' | string
      cause?: 'dimension_mismatch' | 'data_corrupted' | 'missing'
      total?: number
      libraryTotal?: number
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        reason: 'vector' | 'bm25' | 'both' | string
        cause?: 'dimension_mismatch' | 'data_corrupted' | 'missing'
        total?: number
        libraryTotal?: number
      }) => callback(data)
      ipcRenderer.on('knowledge:upgrading', handler)
      return () => {
        ipcRenderer.removeListener('knowledge:upgrading', handler)
      }
    },

    // 监听索引重建进度
    onRebuildProgress: (callback: (data: {
      current: number
      total: number
      libraryTotal?: number
      filename: string
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        current: number
        total: number
        libraryTotal?: number
        filename: string
      }) => callback(data)
      ipcRenderer.on('knowledge:rebuildProgress', handler)
      return () => {
        ipcRenderer.removeListener('knowledge:rebuildProgress', handler)
      }
    },

    // 增量修复索引（只补充缺失文档）
    repairIndex: () =>
      ipcRenderer.invoke('knowledge:repairIndex') as Promise<{
        success: boolean
        checked?: number
        added?: number
        durationMs?: number
        error?: string
      }>,

    // 监听修复进度
    onRepairStarted: (callback: (data: { total: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { total: number }) => callback(data)
      ipcRenderer.on('knowledge:repairStarted', handler)
      return () => { ipcRenderer.removeListener('knowledge:repairStarted', handler) }
    },

    onRepairProgress: (callback: (data: { current: number; total: number; filename: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { current: number; total: number; filename: string }) => callback(data)
      ipcRenderer.on('knowledge:repairProgress', handler)
      return () => { ipcRenderer.removeListener('knowledge:repairProgress', handler) }
    },

    onRepairCompleted: (callback: (data: { added: number; checked: number; durationMs: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { added: number; checked: number; durationMs: number }) => callback(data)
      ipcRenderer.on('knowledge:repairCompleted', handler)
      return () => { ipcRenderer.removeListener('knowledge:repairCompleted', handler) }
    },

    // ==================== 备份 / 恢复 ====================

    // 创建备份（手动，不受时间间隔限制）
    createBackup: () =>
      ipcRenderer.invoke('knowledge:createBackup') as Promise<{
        success: boolean
        backupPath?: string
        error?: string
      }>,

    // 列出所有备份
    listBackups: () =>
      ipcRenderer.invoke('knowledge:listBackups') as Promise<{
        success: boolean
        backups: Array<{
          name: string
          path: string
          createdAt: number
          sizeBytes: number
          automatic: boolean
        }>
        error?: string
      }>,

    // 从备份恢复（恢复后自动增量补差集）
    restoreBackup: (backupPath?: string) =>
      ipcRenderer.invoke('knowledge:restoreBackup', backupPath) as Promise<{
        success: boolean
        backupPath?: string
        error?: string
      }>,

    // 删除指定备份
    deleteBackup: (backupPath: string) =>
      ipcRenderer.invoke('knowledge:deleteBackup', backupPath) as Promise<{
        success: boolean
        error?: string
      }>,

    // ==================== 备份/恢复进度事件 ====================

    onBackupStarted: (callback: (data: { automatic: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { automatic: boolean }) => callback(data)
      ipcRenderer.on('knowledge:backupStarted', handler)
      return () => { ipcRenderer.removeListener('knowledge:backupStarted', handler) }
    },

    onBackupCompleted: (callback: (data: { success: boolean; backupPath?: string; error?: string; skipped?: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { success: boolean; backupPath?: string; error?: string; skipped?: boolean }) => callback(data)
      ipcRenderer.on('knowledge:backupCompleted', handler)
      return () => { ipcRenderer.removeListener('knowledge:backupCompleted', handler) }
    },

    onRestoreStarted: (callback: (data: { backupPath?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { backupPath?: string }) => callback(data)
      ipcRenderer.on('knowledge:restoreStarted', handler)
      return () => { ipcRenderer.removeListener('knowledge:restoreStarted', handler) }
    },

    onRestoreCompleted: (callback: (data: { success: boolean; backupPath?: string; error?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { success: boolean; backupPath?: string; error?: string }) => callback(data)
      ipcRenderer.on('knowledge:restoreCompleted', handler)
      return () => { ipcRenderer.removeListener('knowledge:restoreCompleted', handler) }
    }
  },

  // L2 知识文档（结构化持久记忆）
  contextKnowledge: {
    list: () =>
      ipcRenderer.invoke('contextKnowledge:list') as Promise<{
        success: boolean
        items: Array<{ contextId: string; content: string }>
        maxDocChars: number
        minDocChars: number
        maxDocCharsLimit: number
        error?: string
      }>,
    get: (contextId: string) =>
      ipcRenderer.invoke('contextKnowledge:get', contextId) as Promise<{
        success: boolean
        content: string
        error?: string
      }>,
    set: (contextId: string, content: string) =>
      ipcRenderer.invoke('contextKnowledge:set', contextId, content) as Promise<{
        success: boolean
        error?: string
      }>,
    delete: (contextId: string) =>
      ipcRenderer.invoke('contextKnowledge:delete', contextId) as Promise<{
        success: boolean
        error?: string
      }>,
    setMaxDocChars: (chars: number) =>
      ipcRenderer.invoke('contextKnowledge:setMaxDocChars', chars) as Promise<{
        success: boolean
        maxDocChars: number
        error?: string
      }>
  },

  // 终端屏幕内容服务（供主进程请求渲染进程数据）
  screen: {
    // 注册获取最近 N 行的处理函数
    onRequestLastNLines: (handler: (data: { requestId: string; ptyId: string; lines: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string; ptyId: string; lines: number }) => {
        handler(data)
      }
      ipcRenderer.on('screen:requestLastNLines', listener)
      return () => {
        ipcRenderer.removeListener('screen:requestLastNLines', listener)
      }
    },

    // 注册获取可视内容的处理函数
    onRequestVisibleContent: (handler: (data: { requestId: string; ptyId: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string; ptyId: string }) => {
        handler(data)
      }
      ipcRenderer.on('screen:requestVisibleContent', listener)
      return () => {
        ipcRenderer.removeListener('screen:requestVisibleContent', listener)
      }
    },

    // 响应最近 N 行请求
    responseLastNLines: (requestId: string, lines: string[] | null) => {
      ipcRenderer.send('screen:responseLastNLines', { requestId, lines })
    },

    // 响应可视内容请求
    responseVisibleContent: (requestId: string, lines: string[] | null) => {
      ipcRenderer.send('screen:responseVisibleContent', { requestId, lines })
    },

    // 注册获取屏幕分析的处理函数
    onRequestScreenAnalysis: (handler: (data: { requestId: string; ptyId: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string; ptyId: string }) => {
        handler(data)
      }
      ipcRenderer.on('screen:requestScreenAnalysis', listener)
      return () => {
        ipcRenderer.removeListener('screen:requestScreenAnalysis', listener)
      }
    },

    // 响应屏幕分析请求
    responseScreenAnalysis: (requestId: string, analysis: {
      input: {
        isWaiting: boolean
        type: string
        prompt?: string
        options?: string[]
        suggestedResponse?: string
        confidence: number
      }
      output: {
        type: string
        confidence: number
        details?: {
          progress?: number
          testsPassed?: number
          testsFailed?: number
          errorCount?: number
          eta?: string
        }
      }
      context: {
        user?: string
        hostname?: string
        isRoot: boolean
        cwdFromPrompt?: string
        activeEnvs: string[]
        sshDepth: number
        promptType: string
      }
      visibleContent?: string[]
    } | null) => {
      ipcRenderer.send('screen:responseScreenAnalysis', { requestId, analysis })
    }
  },

  // PPT / HTML 产出物预览（sandbox iframe CSP 兼容）
  ppt: {
    sanitizePreview: (html: string) =>
      ipcRenderer.invoke('ppt:sanitizePreview', html) as Promise<string>,
  },

  // 本地文件系统操作
  localFs: {
    // 获取主目录
    getHomeDir: () =>
      ipcRenderer.invoke('localFs:getHomeDir') as Promise<string>,

    // 获取驱动器列表
    getDrives: () =>
      ipcRenderer.invoke('localFs:getDrives') as Promise<Array<{
        name: string
        path: string
        label?: string
        type: 'fixed' | 'removable' | 'network' | 'cdrom' | 'unknown'
      }>>,

    // 列出目录内容
    list: (dirPath: string) =>
      ipcRenderer.invoke('localFs:list', dirPath) as Promise<{
        success: boolean
        data?: Array<{
          name: string
          path: string
          size: number
          modifyTime: number
          accessTime: number
          isDirectory: boolean
          isSymlink: boolean
          permissions: { user: string; group: string; other: string }
        }>
        error?: string
      }>,

    // 获取文件信息
    stat: (filePath: string) =>
      ipcRenderer.invoke('localFs:stat', filePath) as Promise<{
        success: boolean
        data?: {
          name: string
          path: string
          size: number
          modifyTime: number
          accessTime: number
          isDirectory: boolean
          isSymlink: boolean
          permissions: { user: string; group: string; other: string }
        }
        error?: string
      }>,

    // 检查路径是否存在
    exists: (filePath: string) =>
      ipcRenderer.invoke('localFs:exists', filePath) as Promise<{
        success: boolean
        data?: false | 'd' | '-' | 'l'
        error?: string
      }>,

    // 创建目录
    mkdir: (dirPath: string) =>
      ipcRenderer.invoke('localFs:mkdir', dirPath) as Promise<{
        success: boolean
        error?: string
      }>,

    // 删除文件
    delete: (filePath: string) =>
      ipcRenderer.invoke('localFs:delete', filePath) as Promise<{
        success: boolean
        error?: string
      }>,

    // 删除目录
    rmdir: (dirPath: string) =>
      ipcRenderer.invoke('localFs:rmdir', dirPath) as Promise<{
        success: boolean
        error?: string
      }>,

    // 重命名/移动
    rename: (oldPath: string, newPath: string) =>
      ipcRenderer.invoke('localFs:rename', oldPath, newPath) as Promise<{
        success: boolean
        error?: string
      }>,

    // 复制文件
    copyFile: (src: string, dest: string) =>
      ipcRenderer.invoke('localFs:copyFile', src, dest) as Promise<{
        success: boolean
        error?: string
      }>,

    // 复制目录
    copyDir: (src: string, dest: string) =>
      ipcRenderer.invoke('localFs:copyDir', src, dest) as Promise<{
        success: boolean
        error?: string
      }>,

    // 读取文本文件
    readFile: (filePath: string) =>
      ipcRenderer.invoke('localFs:readFile', filePath) as Promise<{
        success: boolean
        data?: string
        error?: string
      }>,

    previewArtifact: (filePath: string, renderer: string) =>
      ipcRenderer.invoke('localFs:previewArtifact', filePath, renderer) as Promise<{
        success: boolean
        data?: string
        error?: string
      }>,

    // 写入文本文件
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('localFs:writeFile', filePath, content) as Promise<{
        success: boolean
        error?: string
      }>,

    // 获取上级目录
    getParentDir: (filePath: string) =>
      ipcRenderer.invoke('localFs:getParentDir', filePath) as Promise<string>,

    // 拼接路径
    joinPath: (...parts: string[]) =>
      ipcRenderer.invoke('localFs:joinPath', ...parts) as Promise<string>,

    // 获取路径分隔符
    getSeparator: () =>
      ipcRenderer.invoke('localFs:getSeparator') as Promise<string>,

    // 获取常用目录
    getSpecialFolders: () =>
      ipcRenderer.invoke('localFs:getSpecialFolders') as Promise<Array<{
        name: string
        path: string
        icon: string
      }>>,

    // 在系统文件管理器中显示
    showInExplorer: (filePath: string) =>
      ipcRenderer.invoke('localFs:showInExplorer', filePath),

    // 用系统默认程序打开
    openFile: (filePath: string) =>
      ipcRenderer.invoke('localFs:openFile', filePath),

    getFileIcon: (filePath: string) =>
      ipcRenderer.invoke('localFs:getFileIcon', filePath) as Promise<{
        success: boolean
        dataUrl?: string
        error?: string
      }>,

    // 在系统浏览器打开外部 URL（仅 http/https）
    openExternal: (url: string) =>
      ipcRenderer.invoke('localFs:openExternal', url) as Promise<{
        success: boolean
        error?: string
      }>
  },

  // 产出物 webview 预览（sailfish-artifact:// 协议内容供给 + 截图反馈）
  artifactPreview: {
    // 推送预览内容到主进程缓存（sanitize 后的最终 HTML）；await 返回后缓存即就绪
    sync: (payload: { tabId: string; artifactId: string; content: string }) =>
      ipcRenderer.invoke('artifact-preview:sync', payload) as Promise<{ success: boolean }>,

    // 清理预览缓存（不传 artifactId 时清该 tab 全部）
    clear: (tabId: string, artifactId?: string) =>
      ipcRenderer.send('artifact-preview:clear', { tabId, artifactId }),

    // 截取 webview 渲染结果，PNG 落盘 scratch/feedback/ 并返回路径 + dataUrl
    capture: (payload: { webContentsId: number; suggestedName?: string }) =>
      ipcRenderer.invoke('artifact-preview:capture', payload) as Promise<{
        success: boolean
        data?: { filePath: string; dataUrl: string; width: number; height: number }
        error?: string
      }>,

    guestPreloadUrl: () =>
      ipcRenderer.invoke('artifact-preview:guest-preload-url') as Promise<string>
  },

  // 菜单命令监听
  menu: {
    // 监听菜单命令
    onCommand: (callback: (data: { command: string; args: unknown[] }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { command: string; args: unknown[] }) => callback(data)
      ipcRenderer.on('menu:command', handler)
      return () => {
        ipcRenderer.removeListener('menu:command', handler)
      }
    },
    // 通知菜单服务终端标签页状态
    setTerminalState: (hasTerminal: boolean) =>
      ipcRenderer.send('menu:setTerminalState', hasTerminal),
    setAiPanelState: (available: boolean) =>
      ipcRenderer.send('menu:setAiPanelState', available)
  },

  // 文件管理器窗口操作
  fileManager: {
    // 打开文件管理器窗口
    open: (config: {
      sessionId?: string
      sftpConfig?: SftpConfig
      initialLocalPath?: string
      initialRemotePath?: string
    }) => ipcRenderer.invoke('fileManager:open', config),

    // 关闭文件管理器窗口
    close: () => ipcRenderer.invoke('fileManager:close') as Promise<{ closed: boolean }>,

    // 获取窗口初始化参数
    getInitParams: () => ipcRenderer.invoke('fileManager:getInitParams') as Promise<{
      sessionId?: string
      sftpConfig?: SftpConfig
      initialLocalPath?: string
      initialRemotePath?: string
    } | null>,

    // 监听窗口参数更新
    onParamsUpdate: (callback: (params: {
      sessionId?: string
      sftpConfig?: SftpConfig
      initialLocalPath?: string
      initialRemotePath?: string
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, params: Parameters<typeof callback>[0]) => callback(params)
      ipcRenderer.on('fileManager:paramsUpdate', handler)
      return () => {
        ipcRenderer.removeListener('fileManager:paramsUpdate', handler)
      }
    }
  },

  // 邮箱相关
  email: {
    // 设置邮箱凭据
    setCredential: (accountId: string, credential: string) => 
      ipcRenderer.invoke('email:setCredential', accountId, credential) as Promise<void>,
    
    // 删除邮箱凭据
    deleteCredential: (accountId: string) => 
      ipcRenderer.invoke('email:deleteCredential', accountId) as Promise<boolean>,
    
    // 测试邮箱连接
    testConnection: (config: {
      email: string
      password: string
      provider?: string
      imapHost?: string
      imapPort?: number
      smtpHost?: string
      smtpPort?: number
      smtpSecure?: boolean
      rejectUnauthorized?: boolean
    }) => ipcRenderer.invoke('email:testConnection', config) as Promise<{ success: boolean; message: string }>,
    
    // 同步邮箱账户配置到后端
    syncAccounts: (accounts: Array<{
      id: string
      name: string
      email: string
      provider: string
      authType: 'password' | 'oauth2'
      imapHost?: string
      imapPort?: number
      smtpHost?: string
      smtpPort?: number
      smtpSecure?: boolean
      rejectUnauthorized?: boolean
    }>) => ipcRenderer.invoke('email:syncAccounts', accounts) as Promise<void>,

    // 验证已保存的邮箱账户连接
    verifyAccount: (account: {
      id: string
      email: string
      provider?: string
      imapHost?: string
      imapPort?: number
      smtpHost?: string
      smtpPort?: number
      smtpSecure?: boolean
      rejectUnauthorized?: boolean
    }) => ipcRenderer.invoke('email:verifyAccount', account) as Promise<{ success: boolean; message: string }>
  },

  // 日历相关
  calendar: {
    // 设置日历凭据
    setCredential: (accountId: string, credential: string) => 
      ipcRenderer.invoke('calendar:setCredential', accountId, credential) as Promise<void>,
    
    // 删除日历凭据
    deleteCredential: (accountId: string) => 
      ipcRenderer.invoke('calendar:deleteCredential', accountId) as Promise<boolean>,
    
    // 测试日历连接
    testConnection: (config: {
      username: string
      password: string
      provider?: string
      serverUrl?: string
    }) => ipcRenderer.invoke('calendar:testConnection', config) as Promise<{ success: boolean; message: string }>,
    
    // 同步日历账户配置到后端
    syncAccounts: (accounts: Array<{
      id: string
      name: string
      provider: string
      username: string
      serverUrl?: string
    }>) => ipcRenderer.invoke('calendar:syncAccounts', accounts) as Promise<void>,

    // 验证已保存的日历账户连接
    verifyAccount: (account: {
      id: string
      username: string
      provider?: string
      serverUrl?: string
    }) => ipcRenderer.invoke('calendar:verifyAccount', account) as Promise<{ success: boolean; message: string }>
  },

  // 语音识别
  speech: {
    getStatus: () =>
      ipcRenderer.invoke('speech:getStatus') as Promise<{
        initialized: boolean
        modelLoaded: boolean
        modelId: string | null
        packAvailable?: boolean
        error?: string
      }>,

    getModelInfo: () =>
      ipcRenderer.invoke('speech:getModelInfo') as Promise<{
        available: boolean
        packVersion?: string | null
        packSource?: string
        id?: string
        name?: string
        description?: string
        languages?: string[]
        sampleRate?: number
        punctuation?: { id: string; name: string; description: string; available: boolean }
      }>,

    getPackStatus: () =>
      ipcRenderer.invoke('speech:getPackStatus') as Promise<{
        available: boolean
        source: 'userData' | 'bundled' | 'none'
        packVersion: string | null
        format: number | null
        supportedFormat: number
        recommendedVersion: string
        approxSizeBytes: number
        installRoot: string | null
        error?: string
      }>,

    getPackDownloadUrls: () =>
      ipcRenderer.invoke('speech:getPackDownloadUrls') as Promise<{
        github: string
        oss: string
        version: string
      }>,

    installPack: () =>
      ipcRenderer.invoke('speech:installPack') as Promise<{
        success: boolean
        status?: unknown
        error?: string
      }>,

    importPack: () =>
      ipcRenderer.invoke('speech:importPack') as Promise<{
        success: boolean
        cancelled?: boolean
        status?: unknown
        error?: string
      }>,

    uninstallPack: () =>
      ipcRenderer.invoke('speech:uninstallPack') as Promise<{
        success: boolean
        status?: unknown
        error?: string
      }>,

    onPackProgress: (callback: (progress: {
      phase: string
      percent: number
      downloaded?: number
      total?: number
      bytesPerSecond?: number
      etaSeconds?: number
      message?: string
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: {
        phase: string
        percent: number
        downloaded?: number
        total?: number
        bytesPerSecond?: number
        etaSeconds?: number
        message?: string
      }) => callback(progress)
      ipcRenderer.on('speech:pack-progress', handler)
      return () => ipcRenderer.removeListener('speech:pack-progress', handler)
    },

    initialize: () =>
      ipcRenderer.invoke('speech:initialize') as Promise<{
        success: boolean
        error?: string
        hasPunctuation?: boolean
      }>,

    transcribe: (audioData: number[], sampleRate?: number) =>
      ipcRenderer.invoke('speech:transcribe', audioData, sampleRate) as Promise<{
        success: boolean
        result?: {
          text: string
          language?: string
          duration?: number
          hasPunctuation?: boolean
        }
        error?: string
      }>,

    transcribeFile: (filePath: string) =>
      ipcRenderer.invoke('speech:transcribeFile', filePath) as Promise<{
        success: boolean
        result?: {
          text: string
          language?: string
          duration?: number
        }
        error?: string
      }>,

    isReady: () =>
      ipcRenderer.invoke('speech:isReady') as Promise<boolean>
  },

  // TTS 语音合成
  tts: {
    synthesize: (text: string, options?: { voice?: string; model?: string; speed?: number }) =>
      ipcRenderer.invoke('tts:synthesize', text, options) as Promise<{
        success: boolean
        audio?: ArrayBuffer
        format?: string
        error?: string
      }>,

    getVoices: () =>
      ipcRenderer.invoke('tts:getVoices') as Promise<Array<{
        id: string
        name: string
        language?: string
        gender?: string
        previewUrl?: string
      }>>,

    getProviders: () =>
      ipcRenderer.invoke('tts:getProviders') as Promise<Array<{
        id: string
        name: string
      }>>,

    stop: () =>
      ipcRenderer.invoke('tts:stop') as Promise<void>,
  },

  // Web 搜索
  webSearch: {
    updateSettings: (settings: import('@shared/types').WebSearchSettings) =>
      ipcRenderer.invoke('webSearch:updateSettings', settings) as Promise<void>,
  },

  // 定时任务调度
  scheduler: {
    // 获取所有任务
    getTasks: () =>
      ipcRenderer.invoke('scheduler:getTasks') as Promise<ScheduledTask[]>,

    // 获取单个任务
    getTask: (id: string) =>
      ipcRenderer.invoke('scheduler:getTask', id) as Promise<ScheduledTask | undefined>,

    // 创建任务
    createTask: (params: CreateTaskParams) =>
      ipcRenderer.invoke('scheduler:createTask', params) as Promise<ScheduledTask>,

    // 更新任务
    updateTask: (id: string, updates: Partial<CreateTaskParams>) =>
      ipcRenderer.invoke('scheduler:updateTask', id, updates) as Promise<ScheduledTask | null>,

    // 删除任务
    deleteTask: (id: string) =>
      ipcRenderer.invoke('scheduler:deleteTask', id) as Promise<boolean>,

    // 切换任务启用状态
    toggleTask: (id: string) =>
      ipcRenderer.invoke('scheduler:toggleTask', id) as Promise<ScheduledTask | null>,

    // 立即执行任务
    runTask: (id: string) =>
      ipcRenderer.invoke('scheduler:runTask', id) as Promise<TaskExecutionResult>,

    // 获取执行历史
    getHistory: (taskId?: string, limit?: number) =>
      ipcRenderer.invoke('scheduler:getHistory', taskId, limit) as Promise<TaskHistoryRecord[]>,

    // 清除历史记录
    clearHistory: (taskId?: string) =>
      ipcRenderer.invoke('scheduler:clearHistory', taskId) as Promise<void>,

    // 获取 SSH 会话列表
    getSshSessions: () =>
      ipcRenderer.invoke('scheduler:getSshSessions') as Promise<SshSession[]>,

    // 检查任务是否正在运行
    isTaskRunning: (taskId: string) =>
      ipcRenderer.invoke('scheduler:isTaskRunning', taskId) as Promise<boolean>,

    // 获取正在运行的任务列表
    getRunningTasks: () =>
      ipcRenderer.invoke('scheduler:getRunningTasks') as Promise<string[]>,

    // 监听任务开始事件
    onTaskStarted: (callback: (data: { 
      taskId: string
      ptyId: string | null
      taskName: string
      prompt: string  // 任务 prompt，用于启动 Agent
      targetType: 'local' | 'ssh' | 'assistant'
      sshSessionId?: string
      sshSessionName?: string
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { 
        taskId: string
        ptyId: string | null
        taskName: string
        prompt: string
        targetType: 'local' | 'ssh' | 'assistant'
        sshSessionId?: string
        sshSessionName?: string
      }) => callback(data)
      ipcRenderer.on('scheduler:task-started', handler)
      return () => {
        ipcRenderer.removeListener('scheduler:task-started', handler)
      }
    },

    // 监听任务完成事件
    onTaskCompleted: (callback: (data: { taskId: string; result: TaskExecutionResult }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { taskId: string; result: TaskExecutionResult }) => callback(data)
      ipcRenderer.on('scheduler:task-completed', handler)
      return () => {
        ipcRenderer.removeListener('scheduler:task-completed', handler)
      }
    }
  },

  // 本地待办面板（与 Agent todo_* 共用 TODO.json）
  todo: {
    list: (filter?: { status?: string; includeDone?: boolean }) =>
      ipcRenderer.invoke('todo:list', filter),
    create: (input: {
      title: string
      description?: string
      status?: string
      priority?: string
      dueDate?: string
      tags?: string[]
    }) => ipcRenderer.invoke('todo:create', input),
    update: (id: string, patch: Record<string, unknown>) =>
      ipcRenderer.invoke('todo:update', id, patch),
    complete: (id: string) =>
      ipcRenderer.invoke('todo:complete', id),
    delete: (id: string) =>
      ipcRenderer.invoke('todo:delete', id),
    countOverdue: () =>
      ipcRenderer.invoke('todo:countOverdue') as Promise<number>,
    appendJournal: (id: string, entry: Record<string, unknown>) =>
      ipcRenderer.invoke('todo:appendJournal', id, entry),
    addSource: (id: string, source: Record<string, unknown>) =>
      ipcRenderer.invoke('todo:addSource', id, source),
    buildHandoffPrompt: (id: string, kind: 'handle' | 'schedule', minutes?: number) =>
      ipcRenderer.invoke('todo:buildHandoffPrompt', id, kind, minutes) as Promise<string | null>,
    onChanged: (callback: () => void) => {
      const handler = () => { callback() }
      ipcRenderer.on('todo:changed', handler)
      return () => { ipcRenderer.removeListener('todo:changed', handler) }
    },
  },

  // Watch & Sensor（感知层）
  watch: {
    getAll: () =>
      ipcRenderer.invoke('watch:getAll'),
    get: (id: string) =>
      ipcRenderer.invoke('watch:get', id),
    create: (params: any) =>
      ipcRenderer.invoke('watch:create', params),
    update: (id: string, updates: any) =>
      ipcRenderer.invoke('watch:update', id, updates),
    delete: (id: string) =>
      ipcRenderer.invoke('watch:delete', id),
    toggle: (id: string) =>
      ipcRenderer.invoke('watch:toggle', id),
    trigger: (id: string) =>
      ipcRenderer.invoke('watch:trigger', id),
    getHistory: (watchId?: string, limit?: number) =>
      ipcRenderer.invoke('watch:getHistory', watchId, limit),
    clearHistory: (watchId?: string) =>
      ipcRenderer.invoke('watch:clearHistory', watchId),
    isRunning: (id: string) =>
      ipcRenderer.invoke('watch:isRunning', id),
    getRunning: () =>
      ipcRenderer.invoke('watch:getRunning'),
    cancel: (id: string) =>
      ipcRenderer.invoke('watch:cancel', id) as Promise<boolean>,
    getSshSessions: () =>
      ipcRenderer.invoke('watch:getSshSessions'),
    getTemplates: () =>
      ipcRenderer.invoke('watch:getTemplates'),
    getTemplateCategories: () =>
      ipcRenderer.invoke('watch:getTemplateCategories'),
    createFromTemplate: (templateId: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke('watch:createFromTemplate', templateId, options),
    resetHeartbeat: () =>
      ipcRenderer.invoke('watch:resetHeartbeat') as Promise<boolean>,
    onTaskStarted: (callback: (data: { watchId: string; ptyId?: string; watchName?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        if (data && typeof data === 'object' && 'watchId' in data) {
          callback(data as { watchId: string; ptyId?: string; watchName?: string })
        }
      }
      ipcRenderer.on('watch:task-started', handler)
      return () => { ipcRenderer.removeListener('watch:task-started', handler) }
    },
    onTaskCompleted: (callback: (data: { watchId: string; result?: { success: boolean; error?: string } }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        if (data && typeof data === 'object' && 'watchId' in data) {
          callback(data as { watchId: string; result?: { success: boolean; error?: string } })
        }
      }
      ipcRenderer.on('watch:task-completed', handler)
      return () => { ipcRenderer.removeListener('watch:task-completed', handler) }
    },
    onEnsureTab: (callback: (data: { agentId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        if (data && typeof data === 'object' && 'agentId' in data) {
          callback(data as { agentId: string })
        }
      }
      ipcRenderer.on('watch:ensureTab', handler)
      return () => { ipcRenderer.removeListener('watch:ensureTab', handler) }
    },
    onProactiveMessage: (callback: (data: { agentId: string; message: string; watchName: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        if (data && typeof data === 'object') {
          const { agentId, message, watchName } = data as Record<string, unknown>
          if (typeof agentId === 'string' && typeof message === 'string') {
            callback({ agentId, message, watchName: typeof watchName === 'string' ? watchName : '' })
          }
        }
      }
      ipcRenderer.on('watch:proactive-message', handler)
      return () => { ipcRenderer.removeListener('watch:proactive-message', handler) }
    },
    onActivateMessage: (callback: (data: { agentId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        if (data && typeof data === 'object' && 'agentId' in data) {
          callback(data as { agentId: string })
        }
      }
      ipcRenderer.on('watch:activate-message', handler)
      return () => { ipcRenderer.removeListener('watch:activate-message', handler) }
    },
  },

  sensor: {
    getStatus: () =>
      ipcRenderer.invoke('sensor:getStatus'),
    getStatusDetailed: () =>
      ipcRenderer.invoke('sensor:getStatusDetailed'),
    getRecentEvents: (limit?: number) =>
      ipcRenderer.invoke('sensor:getRecentEvents', limit),
    setHeartbeat: (enabled: boolean, intervalMinutes?: number) =>
      ipcRenderer.invoke('sensor:setHeartbeat', enabled, intervalMinutes),
    setAwakened: (awakened: boolean, intervalMinutes?: number) =>
      ipcRenderer.invoke('sensor:setAwakened', awakened, intervalMinutes),
    triggerHeartbeat: () =>
      ipcRenderer.invoke('sensor:triggerHeartbeat'),
  },

  // 应用 SSO（OAuth2/OIDC；features.sso 默认关闭）
  auth: {
    getSession: () =>
      ipcRenderer.invoke('auth:getSession'),
    getAccessToken: () =>
      ipcRenderer.invoke('auth:getAccessToken'),
    getGateMode: () =>
      ipcRenderer.invoke('auth:getGateMode'),
    /** 一条龙：弹窗登录，返回脱敏会话 */
    startLogin: () =>
      ipcRenderer.invoke('auth:startLogin'),
    completeLogin: (code: string, state: string) =>
      ipcRenderer.invoke('auth:completeLogin', code, state),
    logout: () =>
      ipcRenderer.invoke('auth:logout'),
  },

  // 羁绊系统
  bond: {
    getMetrics: () =>
      ipcRenderer.invoke('bond:getMetrics'),
    getMilestones: () =>
      ipcRenderer.invoke('bond:getMilestones'),
    recalculate: () =>
      ipcRenderer.invoke('bond:recalculate'),
  },

  // 文件工具
  fileUtils: {
    // 获取拖放文件的路径（Electron 24+ 推荐方式）
    getPathForFile: (file: File): string => {
      return webUtils.getPathForFile(file)
    }
  },

  workspace: {
    savePastedImage: (dataUrl: string, suggestedName?: string) =>
      ipcRenderer.invoke('workspace:savePastedImage', dataUrl, suggestedName) as Promise<{
        success: boolean
        filePath?: string
        error?: string
      }>,
    deletePastedImage: (filePath: string) =>
      ipcRenderer.invoke('workspace:deletePastedImage', filePath) as Promise<{ success: boolean }>,
  },

  // Shell 操作
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path) as Promise<string>,
    showItemInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path) as Promise<void>
  },

  // AI Debug 调试窗口
  aiDebugOpenWindow: () => ipcRenderer.invoke('aiDebug:openWindow'),
  aiDebugCloseWindow: () => ipcRenderer.invoke('aiDebug:closeWindow') as Promise<{ closed: boolean }>,
  aiDebugIsWindowOpen: () => ipcRenderer.invoke('aiDebug:isWindowOpen') as Promise<boolean>,
  aiDebugGetLogs: () => ipcRenderer.invoke('aiDebug:getLogs'),
  aiDebugClearLogs: () => ipcRenderer.invoke('aiDebug:clearLogs'),
  aiDebugGetLogFilePath: () => ipcRenderer.invoke('aiDebug:getLogFilePath') as Promise<string | null>,
  aiDebugGetLogDir: () => ipcRenderer.invoke('aiDebug:getLogDir') as Promise<string>,
  aiDebugExportLogs: (filePath: string) => ipcRenderer.invoke('aiDebug:exportLogs', filePath) as Promise<{ success: boolean; error?: string }>,
  aiDebugCopyEntry: (entryId: string) => ipcRenderer.invoke('aiDebug:copyEntry', entryId) as Promise<string | null>,
  aiDebugWriteClipboard: (text: string) => ipcRenderer.invoke('aiDebug:writeClipboard', text) as Promise<void>,
  // 写入图片到原生剪贴板。buffer 是 PNG/JPEG 等格式的二进制数据。
  // 前端用这条 IPC 替代 navigator.clipboard.write，避免 "Write permission denied"。
  writeImageToClipboard: (buffer: ArrayBuffer | Uint8Array) => ipcRenderer.invoke('clipboard:writeImage', buffer) as Promise<void>,
  // 弹原生"保存为"对话框写图片到磁盘。
  // 详细契约见 main.ts 的 image:saveWithDialog handler。
  saveImageWithDialog: (payload: {
    defaultName: string
    filters: Array<{ label: string; extensions: string[] }>
    buffers: Record<string, ArrayBuffer | string>
  }) => ipcRenderer.invoke('image:saveWithDialog', payload) as Promise<{
    saved: boolean
    filePath?: string
    filename?: string
  }>,
  onAiDebugMessage: (callback: (message: { type: string; entry?: unknown }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: { type: string; entry?: unknown }) => callback(message)
    ipcRenderer.on('aiDebug:message', handler)
    return () => ipcRenderer.removeListener('aiDebug:message', handler)
  },

  // 堡垒机（JumpServer）集成
  bastion: {
    getConfig: () =>
      ipcRenderer.invoke('bastion:getConfig') as Promise<{ url: string; username: string; password: string; autoJumpHost: boolean; jumpHostPort: number; rejectUnauthorized: boolean }>,
    saveConfig: (config: { url: string; username: string; password: string; autoJumpHost: boolean; jumpHostPort: number; rejectUnauthorized: boolean }) =>
      ipcRenderer.invoke('bastion:saveConfig', config) as Promise<void>,
    testConnection: (config: { url: string; username: string; password: string; rejectUnauthorized: boolean }) =>
      ipcRenderer.invoke('bastion:testConnection', config) as Promise<{ success: boolean; message: string; assetCount?: number }>,
    syncAssets: () =>
      ipcRenderer.invoke('bastion:syncAssets') as Promise<{ success: boolean; error?: string; added: number; updated: number; removed: number; total: number; groupId: string; groupName: string }>,
  },

  // Gateway 远程访问
  gateway: {
    start: (config: { enabled: boolean; port: number; apiToken: string; host: string }) =>
      ipcRenderer.invoke('gateway:start', config) as Promise<{ success: boolean; error?: string }>,
    stop: () =>
      ipcRenderer.invoke('gateway:stop') as Promise<{ success: boolean }>,
    getConfig: () =>
      ipcRenderer.invoke('gateway:getConfig') as Promise<{ enabled: boolean; port: number; apiToken: string; host: string }>,
    isRunning: () =>
      ipcRenderer.invoke('gateway:isRunning') as Promise<boolean>,
    getAutoStart: () =>
      ipcRenderer.invoke('gateway:getAutoStart') as Promise<boolean>,
    setAutoStart: (enabled: boolean) =>
      ipcRenderer.invoke('gateway:setAutoStart', enabled) as Promise<void>,

    // 监听远程助手标签页创建事件
    onRemoteTabCreated: (callback: (data: {
      agentId: string
      title: string
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        agentId: string
        title: string
      }) => callback(data)
      ipcRenderer.on('gateway:remoteTabCreated', handler)
      return () => {
        ipcRenderer.removeListener('gateway:remoteTabCreated', handler)
      }
    },

    // 监听远程任务开始事件
    onRemoteTaskStarted: (callback: (data: {
      agentId: string
      message: string
      remoteChannel?: RemoteChannel
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        agentId: string
        message: string
        remoteChannel?: RemoteChannel
      }) => callback(data)
      ipcRenderer.on('gateway:remoteTaskStarted', handler)
      return () => {
        ipcRenderer.removeListener('gateway:remoteTaskStarted', handler)
      }
    },

    // 获取审计日志
    getAuditLog: (limit?: number) =>
      ipcRenderer.invoke('gateway:getAuditLog', limit) as Promise<Array<{
        id: string
        timestamp: number
        type: string
        clientIp?: string
        summary: string
        details?: Record<string, unknown>
      }>>,

    // 监听审计日志实时推送
    onAuditLog: (callback: (entry: {
      id: string
      timestamp: number
      type: string
      clientIp?: string
      summary: string
      details?: Record<string, unknown>
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, entry: any) => callback(entry)
      ipcRenderer.on('gateway:auditLog', handler)
      return () => {
        ipcRenderer.removeListener('gateway:auditLog', handler)
      }
    }
  },

  // Web Chat 会话（运行时配置）
  webChat: {
    setExecutionMode: (mode: ExecutionMode) =>
      ipcRenderer.invoke('web-chat:setExecutionMode', mode) as Promise<void>,
  },

  // IM 集成
  im: {
    startDingTalk: (config: { enabled: boolean; clientId: string; clientSecret: string }) =>
      ipcRenderer.invoke('im:startDingTalk', config) as Promise<{ success: boolean; error?: string }>,
    stopDingTalk: () =>
      ipcRenderer.invoke('im:stopDingTalk') as Promise<{ success: boolean }>,
    startFeishu: (config: { enabled: boolean; appId: string; appSecret: string }) =>
      ipcRenderer.invoke('im:startFeishu', config) as Promise<{ success: boolean; error?: string }>,
    stopFeishu: () =>
      ipcRenderer.invoke('im:stopFeishu') as Promise<{ success: boolean }>,
    startSlack: (config: { enabled: boolean; botToken: string; appToken: string }) =>
      ipcRenderer.invoke('im:startSlack', config) as Promise<{ success: boolean; error?: string }>,
    stopSlack: () =>
      ipcRenderer.invoke('im:stopSlack') as Promise<{ success: boolean }>,
    startTelegram: (config: { enabled: boolean; botToken: string }) =>
      ipcRenderer.invoke('im:startTelegram', config) as Promise<{ success: boolean; error?: string }>,
    stopTelegram: () =>
      ipcRenderer.invoke('im:stopTelegram') as Promise<{ success: boolean }>,
    startWeCom: (config: { enabled: boolean; botId: string; secret: string }) =>
      ipcRenderer.invoke('im:startWeCom', config) as Promise<{ success: boolean; error?: string }>,
    stopWeCom: () =>
      ipcRenderer.invoke('im:stopWeCom') as Promise<{ success: boolean }>,
    wechatLogin: () =>
      ipcRenderer.invoke('im:wechatLogin') as Promise<{ success: boolean; qrcodeUrl?: string; error?: string }>,
    cancelWeChatLogin: () =>
      ipcRenderer.invoke('im:cancelWeChatLogin') as Promise<{ success: boolean }>,
    startWeChat: () =>
      ipcRenderer.invoke('im:startWeChat') as Promise<{ success: boolean; error?: string }>,
    stopWeChat: () =>
      ipcRenderer.invoke('im:stopWeChat') as Promise<{ success: boolean }>,
    wechatLogout: () =>
      ipcRenderer.invoke('im:wechatLogout') as Promise<{ success: boolean }>,
    getStatus: () =>
      ipcRenderer.invoke('im:getStatus') as Promise<{
        dingtalk: { enabled: boolean; connected: boolean }
        feishu: { enabled: boolean; connected: boolean }
        slack: { enabled: boolean; connected: boolean }
        telegram: { enabled: boolean; connected: boolean }
        wecom: { enabled: boolean; connected: boolean }
        wechat: { enabled: boolean; connected: boolean }
      }>,
    getConfig: () =>
      ipcRenderer.invoke('im:getConfig') as Promise<{
        dingtalk: { clientId: string; clientSecret: string; autoConnect: boolean }
        feishu: { appId: string; appSecret: string; autoConnect: boolean }
        slack: { botToken: string; appToken: string; autoConnect: boolean }
        telegram: { botToken: string; autoConnect: boolean }
        wecom: { botId: string; secret: string; autoConnect: boolean }
        wechat: { hasToken: boolean; autoConnect: boolean }
        executionMode: ExecutionMode
        processMode: IMProcessMode
        sendThinkingProcess: boolean
      }>,
    setAutoConnect: (platform: string, enabled: boolean) =>
      ipcRenderer.invoke('im:setAutoConnect', platform, enabled) as Promise<void>,
    setExecutionMode: (mode: ExecutionMode) =>
      ipcRenderer.invoke('im:setExecutionMode', mode) as Promise<void>,
    setProcessMode: (mode: IMProcessMode) =>
      ipcRenderer.invoke('im:setProcessMode', mode) as Promise<void>,
    setSendThinkingProcess: (enabled: boolean) =>
      ipcRenderer.invoke('im:setSendThinkingProcess', enabled) as Promise<void>,
    sendNotification: (text: string, options?: { markdown?: boolean; title?: string }) =>
      ipcRenderer.invoke('im:sendNotification', text, options) as Promise<{ success: boolean; platform?: string; error?: string }>,

    // 产出物「发送到手机」：按指定渠道直发文件 / 查询各渠道可发状态
    sendFileToChannel: (platform: string, filePath: string, fileName?: string) =>
      ipcRenderer.invoke('im:sendFileToChannel', platform, filePath, fileName) as Promise<{ success: boolean; error?: string }>,
    getChannelSendTargets: () =>
      ipcRenderer.invoke('im:getChannelSendTargets') as Promise<Array<{
        platform: string
        connected: boolean
        hasContact: boolean
        contactName?: string
      }>>,

    // 监听 IM 连接状态变化
    onConnectionChange: (callback: (data: { platform: string; connected: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipcRenderer.on('im:connectionChange', handler)
      return () => {
        ipcRenderer.removeListener('im:connectionChange', handler)
      }
    },

    // 微信扫码过程状态（出码 / 已扫 / 自动刷新 / 确认）
    onWeChatLoginStatus: (callback: (status: import('@shared/types').WeChatLoginStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: import('@shared/types').WeChatLoginStatus) =>
        callback(status)
      ipcRenderer.on('im:wechatLoginStatus', handler)
      return () => {
        ipcRenderer.removeListener('im:wechatLoginStatus', handler)
      }
    },

    onSendFailure: (callback: (data: { platform: string; userId?: string; userName?: string; reason?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { platform: string; userId?: string; userName?: string; reason?: string }) =>
        callback(data)
      ipcRenderer.on('im:sendFailure', handler)
      return () => {
        ipcRenderer.removeListener('im:sendFailure', handler)
      }
    },
  },

  feishuOAuth: {
    startOAuth: () =>
      ipcRenderer.invoke('feishu:startOAuth') as Promise<{ authorized: boolean; userName?: string; openId?: string; error?: string }>,
    revokeOAuth: () =>
      ipcRenderer.invoke('feishu:revokeOAuth') as Promise<{ success: boolean; error?: string }>,
    getOAuthStatus: () =>
      ipcRenderer.invoke('feishu:getOAuthStatus') as Promise<{ authorized: boolean; userName?: string; openId?: string; expiresAt?: number }>,
  },

  // 分屏反向 IPC：主进程 Agent 工具触发渲染进程 store 执行分屏操作
  splitPane: {
    onExec: (
      handler: (
        id: string,
        op:
          | { type: 'split'; direction: 'horizontal' | 'vertical'; target?: { kind: string; sessionId?: string } }
          | { type: 'close'; ptyId: string }
          | { type: 'focus'; ptyId: string }
          | { type: 'list' }
          | { type: 'reconnect'; ptyId?: string },
        ownerAgentKey?: string
      ) => void
    ) => {
      const fn = (_event: Electron.IpcRendererEvent, payload: {
        id: string
        op: Parameters<typeof handler>[1]
        ownerAgentKey?: string
        /** @deprecated 旧字段名，兼容尚未重建的主进程 */
        ownerPtyId?: string
      }) => {
        if (!payload || typeof payload.id !== 'string' || !payload.op) return
        handler(payload.id, payload.op, payload.ownerAgentKey ?? payload.ownerPtyId)
      }
      ipcRenderer.on('split-pane:exec', fn)
      return () => ipcRenderer.removeListener('split-pane:exec', fn)
    },
    sendResult: (id: string, result: { ok: boolean; data?: unknown; error?: string }) => {
      ipcRenderer.send('split-pane:result', { id, result })
    }
  },

  workbench: {
    onExec: (
      handler: (
        id: string,
        op: { type: 'list_artifacts' },
        ownerAgentKey?: string
      ) => void
    ) => {
      const fn = (_event: Electron.IpcRendererEvent, payload: { id: string; op: { type: 'list_artifacts' }; ownerAgentKey?: string }) => {
        if (!payload || typeof payload.id !== 'string' || !payload.op) return
        handler(payload.id, payload.op, payload.ownerAgentKey)
      }
      ipcRenderer.on('workbench:exec', fn)
      return () => ipcRenderer.removeListener('workbench:exec', fn)
    },
    sendResult: (id: string, result: { ok: boolean; data?: unknown; error?: string }) => {
      ipcRenderer.send('workbench:result', { id, result })
    }
  },

  quit: {
    /** macOS ⌘Q 防误触提示，show=true 展示、false 隐藏 */
    onToast: (callback: (payload: { show: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { show: boolean }) => callback(payload)
      ipcRenderer.on('quit:toast', handler)
      return () => ipcRenderer.removeListener('quit:toast', handler)
    },
  },

  browserBridge: {
    getStatus: () =>
      ipcRenderer.invoke('browserBridge:getStatus') as Promise<import('@shared/types/browser-bridge').BrowserBridgeStatus>,
    install: () =>
      ipcRenderer.invoke('browserBridge:install') as Promise<import('@shared/types/browser-bridge').BrowserBridgeInstallStatus>,
    uninstall: () =>
      ipcRenderer.invoke('browserBridge:uninstall') as Promise<{ errors: string[] }>,
    openExtensionGuide: (browser: import('@shared/types/browser-bridge').BrowserBridgeBrowser) =>
      ipcRenderer.invoke('browserBridge:openExtensionGuide', browser),
    onConnectionsChanged: (callback: (status: import('@shared/types/browser-bridge').BrowserBridgeStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: import('@shared/types/browser-bridge').BrowserBridgeStatus) => callback(status)
      ipcRenderer.on('browserBridge:connectionsChanged', handler)
      return () => {
        ipcRenderer.removeListener('browserBridge:connectionsChanged', handler)
      }
    },
  }
}

// 暴露到 window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// 类型声明
declare global {
  interface Window {
    electronAPI: typeof electronAPI
  }
}

