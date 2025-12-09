import { contextBridge, ipcRenderer } from 'electron'

// 类型定义
export interface PtyOptions {
  cols?: number
  rows?: number
  cwd?: string
  shell?: string
  env?: Record<string, string>
}

export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  cols?: number
  rows?: number
  jumpHost?: JumpHostConfig  // 跳板机配置
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
  strictMode?: boolean           // 严格模式：所有命令都需确认，在终端执行
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

    // 更新前端屏幕分析结果（前端 -> 后端）
    updateScreenAnalysis: (ptyId: string, analysis: {
      input: {
        isWaiting: boolean
        type: 'password' | 'confirmation' | 'selection' | 'pager' | 'prompt' | 'editor' | 'custom_input' | 'none'
        prompt?: string
        options?: string[]
        suggestedResponse?: string
        confidence: number
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
      context: {
        user?: string
        hostname?: string
        isRoot: boolean
        cwdFromPrompt?: string
        activeEnvs: string[]
        sshDepth: number
        promptType: 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd' | 'unknown'
      }
      timestamp: number
    }) =>
      ipcRenderer.invoke('terminalAwareness:updateScreenAnalysis', ptyId, analysis),

    // 追踪输出（用于输出速率计算）
    trackOutput: (ptyId: string, lineCount: number) =>
      ipcRenderer.invoke('terminalAwareness:trackOutput', ptyId, lineCount),

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
    getUiTheme: () => ipcRenderer.invoke('config:getUiTheme') as Promise<'dark' | 'light' | 'blue'>,
    setUiTheme: (theme: 'dark' | 'light' | 'blue') => ipcRenderer.invoke('config:setUiTheme', theme),

    // Agent MBTI
    getAgentMbti: () => ipcRenderer.invoke('config:getAgentMbti') as Promise<string | null>,
    setAgentMbti: (mbti: string | null) => ipcRenderer.invoke('config:setAgentMbti', mbti),

    // 首次设置向导
    getSetupCompleted: () => ipcRenderer.invoke('config:getSetupCompleted') as Promise<boolean>,
    setSetupCompleted: (completed: boolean) => ipcRenderer.invoke('config:setSetupCompleted', completed),

    // 语言设置
    getLanguage: () => ipcRenderer.invoke('config:getLanguage') as Promise<string>,
    setLanguage: (language: string) => ipcRenderer.invoke('config:setLanguage', language)
  },

  // Xshell 导入操作
  xshell: {
    selectFiles: () => ipcRenderer.invoke('xshell:selectFiles') as Promise<{ canceled: boolean; filePaths: string[] }>,
    selectDirectory: () => ipcRenderer.invoke('xshell:selectDirectory') as Promise<{ canceled: boolean; dirPath: string }>,
    importFiles: (filePaths: string[]) => ipcRenderer.invoke('xshell:importFiles', filePaths) as Promise<ImportResult>,
    importDirectory: (dirPath: string) => ipcRenderer.invoke('xshell:importDirectory', dirPath) as Promise<ImportResult>,
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
    ) => ipcRenderer.invoke('agent:run', { ptyId, message, context, config, profileId }) as Promise<{ success: boolean; result?: string; error?: string }>,

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

    // 更新 Agent 配置（如严格模式）
    updateConfig: (agentId: string, config: { strictMode?: boolean; commandTimeout?: number }) =>
      ipcRenderer.invoke('agent:updateConfig', agentId, config) as Promise<boolean>,

    // 添加用户补充消息（Agent 执行过程中）
    addMessage: (agentId: string, message: string) =>
      ipcRenderer.invoke('agent:addMessage', agentId, message) as Promise<boolean>,

    // 监听 Agent 步骤更新
    onStep: (callback: (data: { agentId: string; step: AgentStep }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; step: AgentStep }) => callback(data)
      ipcRenderer.on('agent:step', handler)
      return () => {
        ipcRenderer.removeListener('agent:step', handler)
      }
    },

    // 监听需要确认的工具调用
    onNeedConfirm: (callback: (data: PendingConfirmation) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: PendingConfirmation) => callback(data)
      ipcRenderer.on('agent:needConfirm', handler)
      return () => {
        ipcRenderer.removeListener('agent:needConfirm', handler)
      }
    },

    // 监听 Agent 完成
    onComplete: (callback: (data: { agentId: string; result: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; result: string }) => callback(data)
      ipcRenderer.on('agent:complete', handler)
      return () => {
        ipcRenderer.removeListener('agent:complete', handler)
      }
    },

    // 监听 Agent 错误
    onError: (callback: (data: { agentId: string; error: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; error: string }) => callback(data)
      ipcRenderer.on('agent:error', handler)
      return () => {
        ipcRenderer.removeListener('agent:error', handler)
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

    // 导出数据
    exportData: () => ipcRenderer.invoke('history:exportData'),

    // 导入数据
    importData: (data: object) => ipcRenderer.invoke('history:importData', data) as Promise<{
      success: boolean
      error?: string
      configIncluded?: boolean
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
        maxChunkSize: number
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
      maxChunkSize: number
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

    // 检查服务状态
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

