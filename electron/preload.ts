import { contextBridge, ipcRenderer } from 'electron'

// 类型定义
export interface PtyOptions {
  cols?: number
  rows?: number
  cwd?: string
  shell?: string
  env?: Record<string, string>
  encoding?: string  // 字符编码：'auto' | 'utf-8' | 'gbk' | 'big5' | 'shift_jis' 等
}

export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string  // 私钥内容（直接传递）
  privateKeyPath?: string  // 私钥文件路径（从文件读取）
  passphrase?: string  // 私钥密码（可选）
  cols?: number
  rows?: number
  jumpHost?: JumpHostConfig  // 跳板机配置
  encoding?: string  // 字符编码，默认 utf-8
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
}

// 跳板机配置
export interface JumpHostConfig {
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
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

// SFTP 相关类型
export interface SftpConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string | Buffer
  privateKeyPath?: string
  passphrase?: string
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
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
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

// Agent 相关类型
export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'user_task' | 'final_result' | 'user_supplement' | 'waiting' | 'asking'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean
}

export interface AgentContext {
  ptyId: string
  terminalOutput: string[]
  systemInfo: {
    os: string
    shell: string
  }
  hostId?: string  // 主机档案 ID
  historyMessages?: { role: string; content: string }[]
  documentContext?: string  // 用户上传的文档内容
}

export interface AgentConfig {
  enabled?: boolean
  maxSteps?: number
  commandTimeout?: number
  autoExecuteSafe?: boolean
  autoExecuteModerate?: boolean
  executionMode?: 'strict' | 'relaxed' | 'free'  // 执行模式：strict=严格，relaxed=宽松，free=自由
}

export interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
}

// 暴露给渲染进程的 API
const electronAPI = {
  // 应用信息
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion') as Promise<string>
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
    }
  },

  // 自动更新
  updater: {
    // 检查更新
    checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates') as Promise<{
      success: boolean
      updateInfo?: {
        version: string
        releaseNotes?: string
        releaseDate?: string
      }
      error?: string
    }>,

    // 下载更新
    downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate') as Promise<{
      success: boolean
      error?: string
    }>,

    // 安装更新并重启
    quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall') as Promise<{
      success: boolean
      error?: string
    }>,

    // 获取当前更新状态
    getStatus: () => ipcRenderer.invoke('updater:getStatus') as Promise<{
      status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
      info?: {
        version?: string
        releaseNotes?: string
        releaseDate?: string
      }
      progress?: {
        percent: number
        bytesPerSecond: number
        total: number
        transferred: number
      }
      error?: string
    }>,

    // 监听更新状态变化
    onStatusChanged: (callback: (status: {
      status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
      info?: {
        version?: string
        releaseNotes?: string
        releaseDate?: string
      }
      progress?: {
        percent: number
        bytesPerSecond: number
        total: number
        transferred: number
      }
      error?: string
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]) => callback(status)
      ipcRenderer.on('updater:status-changed', handler)
      return () => {
        ipcRenderer.removeListener('updater:status-changed', handler)
      }
    }
  },

  // PTY 操作
  pty: {
    create: (options: PtyOptions) => ipcRenderer.invoke('pty:create', options),
    write: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resize', id, cols, rows),
    dispose: (id: string) => ipcRenderer.invoke('pty:dispose', id),
    executeInTerminal: (id: string, command: string, timeout?: number) =>
      ipcRenderer.invoke('pty:executeInTerminal', id, command, timeout) as Promise<{
        success: boolean
        output?: string
        exitCode?: number
        error?: string
      }>,
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
    connect: (config: SshConfig) => ipcRenderer.invoke('ssh:connect', config),
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
    startExecution: (id: string, command: string) =>
      ipcRenderer.invoke('terminalState:startExecution', id, command) as Promise<{
        id: string
        terminalId: string
        command: string
        startTime: number
        cwdBefore: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
        output?: string
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
    abort: (requestId?: string) => ipcRenderer.invoke('ai:abort', requestId)
  },

  // 配置操作
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('config:set', key, value),
    getAll: () => ipcRenderer.invoke('config:getAll'),

    // AI 配置
    getAiProfiles: () => ipcRenderer.invoke('config:getAiProfiles'),
    setAiProfiles: (profiles: AiProfile[]) =>
      ipcRenderer.invoke('config:setAiProfiles', profiles),
    getActiveAiProfile: () => ipcRenderer.invoke('config:getActiveAiProfile'),
    setActiveAiProfile: (profileId: string) =>
      ipcRenderer.invoke('config:setActiveAiProfile', profileId),

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
    getUiTheme: () => ipcRenderer.invoke('config:getUiTheme') as Promise<'dark' | 'light' | 'blue' | 'sponsor-gold' | 'sponsor-sakura' | 'sponsor-forest'>,
    setUiTheme: (theme: 'dark' | 'light' | 'blue' | 'sponsor-gold' | 'sponsor-sakura' | 'sponsor-forest') => ipcRenderer.invoke('config:setUiTheme', theme),

    // Agent MBTI
    getAgentMbti: () => ipcRenderer.invoke('config:getAgentMbti') as Promise<string | null>,
    setAgentMbti: (mbti: string | null) => ipcRenderer.invoke('config:setAgentMbti', mbti),

    // Agent 调试模式
    getAgentDebugMode: () => ipcRenderer.invoke('config:getAgentDebugMode') as Promise<boolean>,
    setAgentDebugMode: (enabled: boolean) => ipcRenderer.invoke('config:setAgentDebugMode', enabled),

    // 首次设置向导
    getSetupCompleted: () => ipcRenderer.invoke('config:getSetupCompleted') as Promise<boolean>,
    setSetupCompleted: (completed: boolean) => ipcRenderer.invoke('config:setSetupCompleted', completed),

    // 语言设置
    getLanguage: () => ipcRenderer.invoke('config:getLanguage') as Promise<string>,
    setLanguage: (language: string) => ipcRenderer.invoke('config:setLanguage', language),

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
    getRemoteBookmarks: (hostId?: string) => ipcRenderer.invoke('config:getRemoteBookmarks', hostId) as Promise<FileBookmark[]>
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

    // 中止 Agent
    abort: (agentId: string) => ipcRenderer.invoke('agent:abort', agentId) as Promise<boolean>,

    // 确认工具调用
    confirm: (
      agentId: string,
      toolCallId: string,
      approved: boolean,
      modifiedArgs?: Record<string, unknown>
    ) => ipcRenderer.invoke('agent:confirm', { agentId, toolCallId, approved, modifiedArgs }) as Promise<boolean>,

    // 获取 Agent 状态
    getStatus: (agentId: string) => ipcRenderer.invoke('agent:getStatus', agentId),

    // 清理 Agent 运行记录
    cleanup: (agentId: string) => ipcRenderer.invoke('agent:cleanup', agentId),

    // 更新 Agent 配置（如执行模式、超时时间）
    updateConfig: (agentId: string, config: { executionMode?: 'strict' | 'relaxed' | 'free'; commandTimeout?: number }) =>
      ipcRenderer.invoke('agent:updateConfig', agentId, config) as Promise<boolean>,

    // 添加用户补充消息（Agent 执行过程中）
    addMessage: (agentId: string, message: string) =>
      ipcRenderer.invoke('agent:addMessage', agentId, message) as Promise<boolean>,

    // 获取执行阶段状态（用于智能打断判断）
    getExecutionPhase: (agentId: string) =>
      ipcRenderer.invoke('agent:getExecutionPhase', agentId) as Promise<{
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

    // 监听需要确认的工具调用（携带 ptyId 用于可靠匹配 tab）
    onNeedConfirm: (callback: (data: PendingConfirmation & { ptyId?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: PendingConfirmation & { ptyId?: string }) => callback(data)
      ipcRenderer.on('agent:needConfirm', handler)
      return () => {
        ipcRenderer.removeListener('agent:needConfirm', handler)
      }
    },

    // 监听 Agent 完成（携带 ptyId 用于可靠匹配 tab，可能附带未处理的用户消息）
    onComplete: (callback: (data: { agentId: string; ptyId?: string; result: string; pendingUserMessages?: string[] }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; ptyId?: string; result: string; pendingUserMessages?: string[] }) => callback(data)
      ipcRenderer.on('agent:complete', handler)
      return () => {
        ipcRenderer.removeListener('agent:complete', handler)
      }
    },

    // 监听 Agent 错误（携带 ptyId 用于可靠匹配 tab）
    onError: (callback: (data: { agentId: string; ptyId?: string; error: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; ptyId?: string; error: string }) => callback(data)
      ipcRenderer.on('agent:error', handler)
      return () => {
        ipcRenderer.removeListener('agent:error', handler)
      }
    }
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
    // 保存聊天记录
    saveChatRecord: (record: {
      id: string
      timestamp: number
      terminalId: string
      terminalType: 'local' | 'ssh'
      sshHost?: string
      role: 'user' | 'assistant'
      content: string
    }) => ipcRenderer.invoke('history:saveChatRecord', record),

    // 批量保存聊天记录
    saveChatRecords: (records: Array<{
      id: string
      timestamp: number
      terminalId: string
      terminalType: 'local' | 'ssh'
      sshHost?: string
      role: 'user' | 'assistant'
      content: string
    }>) => ipcRenderer.invoke('history:saveChatRecords', records),

    // 获取聊天记录
    getChatRecords: (startDate?: string, endDate?: string) => 
      ipcRenderer.invoke('history:getChatRecords', startDate, endDate),

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

    // 获取数据目录路径
    getDataPath: () => ipcRenderer.invoke('history:getDataPath') as Promise<string>,

    // 获取存储统计
    getStorageStats: () => ipcRenderer.invoke('history:getStorageStats') as Promise<{
      chatFiles: number
      agentFiles: number
      totalSize: number
      oldestRecord?: string
      newestRecord?: string
    }>,

    // 清理旧记录
    cleanup: (daysToKeep: number) => ipcRenderer.invoke('history:cleanup', daysToKeep) as Promise<{
      chatDeleted: number
      agentDeleted: number
    }>,

    // 导出到文件夹
    exportToFolder: (options?: { includeSshPasswords?: boolean; includeApiKeys?: boolean }) => 
      ipcRenderer.invoke('history:exportToFolder', options) as Promise<{
        success: boolean
        canceled?: boolean
        files?: string[]
        error?: string
      }>,

    // 从文件夹导入
    importFromFolder: () => ipcRenderer.invoke('history:importFromFolder') as Promise<{
      success: boolean
      canceled?: boolean
      imported?: string[]
      error?: string
    }>,

    // 在文件管理器中打开数据目录
    openDataFolder: () => ipcRenderer.invoke('history:openDataFolder')
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
    }) => ipcRenderer.invoke('document:parse', file, options) as Promise<{
      filename: string
      fileType: string
      content: string
      fileSize: number
      parseTime: number
      pageCount?: number
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
    }) => ipcRenderer.invoke('document:parseMultiple', files, options) as Promise<Array<{
      filename: string
      fileType: string
      content: string
      fileSize: number
      parseTime: number
      pageCount?: number
      metadata?: Record<string, string>
      error?: string
    }>>,

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
        embeddingMcpServerId?: string
        autoSaveUploads: boolean
        chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
        searchTopK: number
        enableRerank: boolean
        mcpKnowledgeServerId?: string
      }>,

    // 更新设置
    updateSettings: (settings: Partial<{
      enabled: boolean
      embeddingMode: 'local' | 'mcp'
      localModel: 'auto' | 'lite' | 'standard' | 'large'
      embeddingMcpServerId?: string
      autoSaveUploads: boolean
      chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
      searchTopK: number
      enableRerank: boolean
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

    // ==================== 密码管理 ====================
    
    // 获取密码状态
    getPasswordInfo: () =>
      ipcRenderer.invoke('knowledge:getPasswordInfo') as Promise<{
        hasPassword: boolean
        isUnlocked: boolean
        createdAt?: number
      }>,

    // 设置密码
    setPassword: (password: string) =>
      ipcRenderer.invoke('knowledge:setPassword', password) as Promise<{ success: boolean; error?: string }>,

    // 验证密码（解锁）
    verifyPassword: (password: string) =>
      ipcRenderer.invoke('knowledge:verifyPassword', password) as Promise<{ success: boolean; error?: string }>,

    // 修改密码
    changePassword: (oldPassword: string, newPassword: string) =>
      ipcRenderer.invoke('knowledge:changePassword', oldPassword, newPassword) as Promise<{ success: boolean; error?: string }>,

    // 锁定知识库
    lock: () =>
      ipcRenderer.invoke('knowledge:lock') as Promise<{ success: boolean }>,

    // 检查是否存在加密数据
    checkEncryptedData: () =>
      ipcRenderer.invoke('knowledge:checkEncryptedData') as Promise<{ hasEncryptedData: boolean; encryptedCount: number }>,

    // 清除密码（会自动解密所有加密数据后再清除）
    clearPassword: (password: string) =>
      ipcRenderer.invoke('knowledge:clearPassword', password) as Promise<{ 
        success: boolean; 
        error?: string;
        decryptedCount?: number;
        message?: string;
      }>,

    // 监听知识库服务就绪事件
    onReady: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('knowledge:ready', handler)
      return () => {
        ipcRenderer.removeListener('knowledge:ready', handler)
      }
    },

    // 监听知识库升级事件（模型变化导致索引重建）
    onUpgrading: (callback: (data: { reason: string; message: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { reason: string; message: string }) => callback(data)
      ipcRenderer.on('knowledge:upgrading', handler)
      return () => {
        ipcRenderer.removeListener('knowledge:upgrading', handler)
      }
    },

    // 监听索引重建进度
    onRebuildProgress: (callback: (data: { current: number; total: number; filename: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { current: number; total: number; filename: string }) => callback(data)
      ipcRenderer.on('knowledge:rebuildProgress', handler)
      return () => {
        ipcRenderer.removeListener('knowledge:rebuildProgress', handler)
      }
    }
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
      ipcRenderer.invoke('localFs:openFile', filePath)
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
    close: () => ipcRenderer.invoke('fileManager:close'),

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

