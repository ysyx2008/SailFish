/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

// Agent 相关类型
type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

// 计划步骤进度
interface PlanStepProgress {
  value: number
  current?: number
  total?: number
  eta?: string
  speed?: string
  isIndeterminate: boolean
  statusText?: string
}

// 计划步骤
interface AgentPlanStep {
  id: string
  title: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  result?: string
  progress?: PlanStepProgress
}

// Agent 执行计划
interface AgentPlan {
  id: string
  title: string
  steps: AgentPlanStep[]
  createdAt: number
  updatedAt: number
}

interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'user_task' | 'final_result' | 'user_supplement' | 'waiting' | 'asking' | 'waiting_password' | 'plan_created' | 'plan_updated'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean
  plan?: AgentPlan  // 计划数据
}

interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
}

interface HostProfile {
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
}

// MCP 相关类型
interface McpServerConfig {
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

interface McpTool {
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

interface McpResource {
  serverId: string
  serverName: string
  uri: string
  name: string
  description?: string
  mimeType?: string
}

interface McpPrompt {
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

interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  error?: string
  toolCount: number
  resourceCount: number
  promptCount: number
}

// Electron API 类型
interface Window {
  electronAPI: {
    // 应用信息
    app: {
      getVersion: () => Promise<string>
    }
    // PATH 环境变量状态
    path: {
      isReady: () => Promise<boolean>
      waitReady: () => Promise<boolean>
      onReady: (callback: () => void) => () => void
    }
    // 窗口操作
    window: {
      close: () => Promise<void>
      forceQuit: () => Promise<void>
      onRequestTerminalCount: (callback: () => void) => () => void
      responseTerminalCount: (count: number) => void
    }
    // 自动更新
    updater: {
      checkForUpdates: () => Promise<{
        success: boolean
        updateInfo?: {
          version: string
          releaseNotes?: string
          releaseDate?: string
        }
        error?: string
      }>
      downloadUpdate: () => Promise<{
        success: boolean
        error?: string
      }>
      quitAndInstall: () => Promise<{
        success: boolean
        error?: string
      }>
      getStatus: () => Promise<{
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
      }>
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
      }) => void) => () => void
    }
    pty: {
      create: (options?: {
        cols?: number
        rows?: number
        cwd?: string
        shell?: string
        env?: Record<string, string>
        encoding?: string
      }) => Promise<string>
      write: (id: string, data: string) => Promise<void>
      resize: (id: string, cols: number, rows: number) => Promise<void>
      dispose: (id: string) => Promise<void>
      executeInTerminal: (id: string, command: string, timeout?: number) => Promise<{
        success: boolean
        output?: string
        exitCode?: number
        error?: string
      }>
      getAvailableShells: () => Promise<Array<{
        label: string
        value: string
        icon: string
      }>>
      onData: (id: string, callback: (data: string) => void) => () => void
    }
    ssh: {
      connect: (config: {
        host: string
        port: number
        username: string
        password?: string
        privateKey?: string  // 私钥内容（直接传递）
        privateKeyPath?: string  // 私钥文件路径（从文件读取）
        passphrase?: string  // 私钥密码（可选）
        cols?: number
        rows?: number
        jumpHost?: {
          host: string
          port: number
          username: string
          authType: 'password' | 'privateKey'
          password?: string
          privateKeyPath?: string
          passphrase?: string
        }
        encoding?: string
      }) => Promise<string>
      write: (id: string, data: string) => Promise<void>
      resize: (id: string, cols: number, rows: number) => Promise<void>
      disconnect: (id: string) => Promise<void>
      onData: (id: string, callback: (data: string) => void) => () => void
      onDisconnected: (id: string, callback: (event: { reason: string; error?: string }) => void) => () => void
    }
    terminalState: {
      init: (id: string, type: 'local' | 'ssh', initialCwd?: string) => Promise<void>
      remove: (id: string) => Promise<void>
      get: (id: string) => Promise<{
        id: string
        type: 'local' | 'ssh'
        cwd: string
        cwdUpdatedAt: number
        lastCommand?: string
        lastExitCode?: number
        isIdle: boolean
        lastActivityAt: number
      } | undefined>
      getCwd: (id: string) => Promise<string>
      refreshCwd: (id: string) => Promise<string>
      updateCwd: (id: string, newCwd: string) => Promise<void>
      handleInput: (id: string, input: string) => Promise<void>
      getIdleState: (id: string) => Promise<boolean>
      onCwdChange: (callback: (event: {
        terminalId: string
        oldCwd: string
        newCwd: string
        timestamp: number
        trigger: 'command' | 'pwd_check' | 'initial'
      }) => void) => () => void
      startExecution: (id: string, command: string) => Promise<{
        id: string
        terminalId: string
        command: string
        startTime: number
        cwdBefore: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
        output?: string
      } | null>
      appendOutput: (id: string, output: string) => Promise<void>
      completeExecution: (id: string, exitCode?: number, status?: 'completed' | 'failed' | 'timeout' | 'cancelled') => Promise<{
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
      } | null>
      getCurrentExecution: (id: string) => Promise<{
        id: string
        terminalId: string
        command: string
        startTime: number
        cwdBefore: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
        output?: string
      } | undefined>
      getExecutionHistory: (id: string, limit?: number) => Promise<Array<{
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
      }>>
      getLastExecution: (id: string) => Promise<{
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
      } | undefined>
      clearExecutionHistory: (id: string) => Promise<void>
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
      }) => void) => () => void
    }
    terminalAwareness: {
      getAwareness: (ptyId: string) => Promise<{
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
      }>
      getVisibleContent: (ptyId: string) => Promise<string[] | null>
      trackOutput: (ptyId: string, lineCount: number) => Promise<void>
      canExecute: (ptyId: string) => Promise<boolean>
      getPreExecutionAdvice: (ptyId: string, command: string) => Promise<{
        canExecute: boolean
        reason?: string
        suggestion?: string
      }>
      clear: (ptyId: string) => Promise<void>
    }
    ai: {
      chat: (
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        profileId?: string
      ) => Promise<string>
      chatStream: (
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        onChunk: (chunk: string) => void,
        onDone: () => void,
        onError: (error: string) => void,
        profileId?: string,
        requestId?: string
      ) => void
      abort: (requestId?: string) => Promise<void>
    }
    config: {
      get: (key: string) => Promise<unknown>
      set: (key: string, value: unknown) => Promise<void>
      getAll: () => Promise<Record<string, unknown>>
      getAiProfiles: () => Promise<
        Array<{
          id: string
          name: string
          apiUrl: string
          apiKey: string
          model: string
          proxy?: string
        }>
      >
      setAiProfiles: (
        profiles: Array<{
          id: string
          name: string
          apiUrl: string
          apiKey: string
          model: string
          proxy?: string
        }>
      ) => Promise<void>
      getActiveAiProfile: () => Promise<string>
      setActiveAiProfile: (profileId: string) => Promise<void>
      getSshSessions: () => Promise<
        Array<{
          id: string
          name: string
          host: string
          port: number
          username: string
          authType: 'password' | 'privateKey'
          password?: string
          privateKeyPath?: string
          passphrase?: string
          group?: string
        }>
      >
      setSshSessions: (
        sessions: Array<{
          id: string
          name: string
          host: string
          port: number
          username: string
          authType: 'password' | 'privateKey'
          password?: string
          privateKeyPath?: string
          passphrase?: string
          group?: string
        }>
      ) => Promise<void>
      getTheme: () => Promise<string>
      setTheme: (theme: string) => Promise<void>
      getUiTheme: () => Promise<'dark' | 'light' | 'blue' | 'sponsor-gold' | 'sponsor-sakura' | 'sponsor-forest'>
      setUiTheme: (theme: 'dark' | 'light' | 'blue' | 'sponsor-gold' | 'sponsor-sakura' | 'sponsor-forest') => Promise<void>
      // 会话分组
      getSessionGroups: () => Promise<Array<{
        id: string
        name: string
        jumpHost?: {
          host: string
          port: number
          username: string
          authType: 'password' | 'privateKey'
          password?: string
          privateKeyPath?: string
          passphrase?: string
        }
      }>>
      setSessionGroups: (groups: Array<{
        id: string
        name: string
        jumpHost?: {
          host: string
          port: number
          username: string
          authType: 'password' | 'privateKey'
          password?: string
          privateKeyPath?: string
          passphrase?: string
        }
      }>) => Promise<void>
      // Agent MBTI
      getAgentMbti: () => Promise<string | null>
      setAgentMbti: (mbti: string | null) => Promise<void>
      // 首次设置向导
      getSetupCompleted: () => Promise<boolean>
      setSetupCompleted: (completed: boolean) => Promise<void>
      // 语言设置
      getLanguage: () => Promise<string>
      setLanguage: (language: string) => Promise<void>
      // 赞助状态
      getSponsorStatus: () => Promise<boolean>
      setSponsorStatus: (status: boolean) => Promise<void>
      // 排序设置
      getSessionSortBy: () => Promise<string>
      setSessionSortBy: (sortBy: string) => Promise<void>
      getDefaultGroupSortOrder: () => Promise<number>
      setDefaultGroupSortOrder: (order: number) => Promise<void>
    }
    xshell: {
      selectFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
      selectDirectory: () => Promise<{ canceled: boolean; dirPath: string }>
      importFiles: (filePaths: string[]) => Promise<{
        success: boolean
        sessions: Array<{
          name: string
          host: string
          port: number
          username: string
          password?: string
          privateKeyPath?: string
          group?: string
        }>
        errors: string[]
      }>
      importDirectory: (dirPath: string) => Promise<{
        success: boolean
        sessions: Array<{
          name: string
          host: string
          port: number
          username: string
          password?: string
          privateKeyPath?: string
          group?: string
        }>
        errors: string[]
        debug?: { totalFiles: number; parsedFiles: number; failedFiles: number }
      }>
      importDirectories: (dirPaths: string[]) => Promise<{
        success: boolean
        sessions: Array<{
          name: string
          host: string
          port: number
          username: string
          password?: string
          privateKeyPath?: string
          group?: string
        }>
        errors: string[]
        debug?: { totalFiles: number; parsedFiles: number; failedFiles: number }
      }>
      scanDefaultPaths: () => Promise<{ found: boolean; paths: string[]; sessionCount: number }>
    }
    // Agent 操作
    agent: {
      run: (
        ptyId: string,
        message: string,
        context: {
          ptyId: string
          terminalOutput: string[]
          systemInfo: { os: string; shell: string }
          terminalType: 'local' | 'ssh'
          hostId?: string
          historyMessages?: { role: string; content: string }[]
          documentContext?: string
        },
        config?: {
          enabled?: boolean
          maxSteps?: number
          commandTimeout?: number
          autoExecuteSafe?: boolean
          autoExecuteModerate?: boolean
          executionMode?: 'strict' | 'relaxed' | 'free'
        },
        profileId?: string
      ) => Promise<{ success: boolean; result?: string; error?: string }>
      abort: (agentId: string) => Promise<boolean>
      confirm: (
        agentId: string,
        toolCallId: string,
        approved: boolean,
        modifiedArgs?: Record<string, unknown>
      ) => Promise<boolean>
      getStatus: (agentId: string) => Promise<unknown>
      cleanup: (agentId: string) => Promise<void>
      updateConfig: (agentId: string, config: { executionMode?: 'strict' | 'relaxed' | 'free'; commandTimeout?: number }) => Promise<boolean>
      addMessage: (agentId: string, message: string) => Promise<boolean>
      getExecutionPhase: (agentId: string) => Promise<{
        phase: 'thinking' | 'executing_command' | 'writing_file' | 'waiting' | 'confirming' | 'idle'
        currentToolName?: string
        canInterrupt: boolean
        interruptWarning?: string
      } | null>
      onStep: (callback: (data: { agentId: string; step: AgentStep }) => void) => () => void
      onNeedConfirm: (callback: (data: PendingConfirmation) => void) => () => void
      onComplete: (callback: (data: { agentId: string; result: string; pendingUserMessages?: string[] }) => void) => () => void
      onError: (callback: (data: { agentId: string; error: string }) => void) => () => void
    }
    // 历史记录操作
    history: {
      saveChatRecord: (record: {
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        role: 'user' | 'assistant'
        content: string
      }) => Promise<void>
      saveChatRecords: (records: Array<{
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        role: 'user' | 'assistant'
        content: string
      }>) => Promise<void>
      getChatRecords: (startDate?: string, endDate?: string) => Promise<Array<{
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        role: 'user' | 'assistant'
        content: string
      }>>
      saveAgentRecord: (record: {
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        userTask: string
        steps: AgentStep[]
        finalResult?: string
        status: 'completed' | 'failed' | 'aborted'
        duration: number
      }) => Promise<void>
      getAgentRecords: (startDate?: string, endDate?: string) => Promise<Array<{
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        userTask: string
        steps: AgentStep[]
        finalResult: string
        status: 'completed' | 'failed' | 'aborted'
        duration: number
      }>>
      getStorageStats: () => Promise<{
        chatFiles: number
        agentFiles: number
        totalSize: number
        oldestRecord?: string
        newestRecord?: string
      }>
      getDataPath: () => Promise<string>
      openDataFolder: () => Promise<void>
      exportToFolder: (options: {
        includeSshPasswords: boolean
        includeApiKeys: boolean
      }) => Promise<{ success: boolean; canceled?: boolean; files?: string[]; path?: string; error?: string }>
      exportData: () => Promise<{
        version: string
        exportTime: number
        config: Record<string, unknown>
        history: {
          chat: Array<unknown>
          agent: Array<unknown>
        }
      }>
      importFromFolder: () => Promise<{ success: boolean; canceled?: boolean; imported?: string[]; error?: string }>
      importData: (data: {
        version: string
        exportTime: number
        config: Record<string, unknown>
        history: {
          chat: Array<unknown>
          agent: Array<unknown>
        }
        hostProfiles?: unknown[]
      }) => Promise<{ success: boolean; imported?: { chat: number; agent: number; config: boolean }; error?: string }>
      cleanup: (days: number) => Promise<{ success: boolean; chatDeleted?: number; agentDeleted?: number; error?: string }>
    }
    // 主机档案操作
    hostProfile: {
      get: (hostId: string) => Promise<HostProfile | null>
      getAll: () => Promise<HostProfile[]>
      update: (hostId: string, updates: Partial<HostProfile>) => Promise<HostProfile>
      addNote: (hostId: string, note: string) => Promise<void>
      delete: (hostId: string) => Promise<void>
      getProbeCommands: (os: string) => Promise<string[]>
      parseProbeOutput: (output: string, hostId?: string) => Promise<{
        hostname?: string
        username?: string
        os?: string
        osVersion?: string
        shell?: string
        packageManager?: string
        installedTools?: string[]
        homeDir?: string
        currentDir?: string
      }>
      generateHostId: (type: 'local' | 'ssh', sshHost?: string, sshUser?: string) => Promise<string>
      needsProbe: (hostId: string) => Promise<boolean>
      probeLocal: () => Promise<HostProfile>
      probeSsh: (sshId: string, hostId: string) => Promise<HostProfile | null>
      generateContext: (hostId: string) => Promise<string>
    }
    // SFTP 操作
    sftp: {
      connect: (sessionId: string, config: {
        host: string
        port: number
        username: string
        password?: string
        privateKey?: string | Buffer
        privateKeyPath?: string
        passphrase?: string
      }) => Promise<{ success: boolean; error?: string }>
      disconnect: (sessionId: string) => Promise<void>
      hasSession: (sessionId: string) => Promise<boolean>
      list: (sessionId: string, remotePath: string) => Promise<{
        success: boolean
        data?: Array<{
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
        }>
        resolvedPath?: string
        error?: string
      }>
      pwd: (sessionId: string) => Promise<{
        success: boolean
        data?: string
        error?: string
      }>
      exists: (sessionId: string, remotePath: string) => Promise<{
        success: boolean
        data?: false | 'd' | '-' | 'l'
        error?: string
      }>
      stat: (sessionId: string, remotePath: string) => Promise<{
        success: boolean
        data?: object
        error?: string
      }>
      upload: (sessionId: string, localPath: string, remotePath: string, transferId: string) => Promise<{
        success: boolean
        error?: string
      }>
      download: (sessionId: string, remotePath: string, localPath: string, transferId: string) => Promise<{
        success: boolean
        error?: string
      }>
      uploadDir: (sessionId: string, localDir: string, remoteDir: string) => Promise<{
        success: boolean
        error?: string
      }>
      downloadDir: (sessionId: string, remoteDir: string, localDir: string) => Promise<{
        success: boolean
        error?: string
      }>
      mkdir: (sessionId: string, remotePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      delete: (sessionId: string, remotePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      rmdir: (sessionId: string, remotePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      rename: (sessionId: string, oldPath: string, newPath: string) => Promise<{
        success: boolean
        error?: string
      }>
      chmod: (sessionId: string, remotePath: string, mode: string | number) => Promise<{
        success: boolean
        error?: string
      }>
      readFile: (sessionId: string, remotePath: string) => Promise<{
        success: boolean
        data?: string
        error?: string
      }>
      writeFile: (sessionId: string, remotePath: string, content: string) => Promise<{
        success: boolean
        error?: string
      }>
      getTransfers: () => Promise<Array<{
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
      }>>
      selectLocalFiles: () => Promise<{
        canceled: boolean
        files: Array<{
          name: string
          path: string
          size: number
          isDirectory: boolean
        }>
      }>
      selectLocalDirectory: (options?: { title?: string; forSave?: boolean }) => Promise<{
        canceled: boolean
        path: string
      }>
      selectSavePath: (defaultName: string) => Promise<{
        canceled: boolean
        path: string
      }>
      onTransferStart: (callback: (progress: {
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
      }) => void) => () => void
      onTransferProgress: (callback: (progress: {
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
      }) => void) => () => void
      onTransferComplete: (callback: (progress: {
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
      }) => void) => () => void
      onTransferError: (callback: (progress: {
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
      }) => void) => () => void
      onTransferCancelled: (callback: (progress: {
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
      }) => void) => () => void
      cancelTransfer: (transferId: string) => Promise<{ success: boolean; error?: string }>
    }
    // 文档解析操作
    document: {
      selectFiles: () => Promise<{
        canceled: boolean
        files: Array<{
          name: string
          path: string
          size: number
        }>
      }>
      parse: (file: {
        name: string
        path: string
        size: number
        mimeType?: string
      }, options?: {
        maxFileSize?: number
        maxTextLength?: number
        extractMetadata?: boolean
      }) => Promise<{
        filename: string
        fileType: string
        content: string
        fileSize: number
        parseTime: number
        pageCount?: number
        metadata?: Record<string, string>
        error?: string
      }>
      parseMultiple: (files: Array<{
        name: string
        path: string
        size: number
        mimeType?: string
      }>, options?: {
        maxFileSize?: number
        maxTextLength?: number
        extractMetadata?: boolean
      }) => Promise<Array<{
        filename: string
        fileType: string
        content: string
        fileSize: number
        parseTime: number
        pageCount?: number
        metadata?: Record<string, string>
        error?: string
      }>>
      formatAsContext: (docs: Array<{
        filename: string
        fileType: string
        content: string
        fileSize: number
        parseTime: number
        pageCount?: number
        metadata?: Record<string, string>
        error?: string
      }>) => Promise<string>
      generateSummary: (doc: {
        filename: string
        fileType: string
        content: string
        fileSize: number
        parseTime: number
        pageCount?: number
        error?: string
      }) => Promise<string>
      checkCapabilities: () => Promise<{
        pdf: boolean
        docx: boolean
        doc: boolean
        text: boolean
      }>
      getSupportedTypes: () => Promise<Array<{
        extension: string
        description: string
        available: boolean
      }>>
    }
    // MCP 操作
    mcp: {
      getServers: () => Promise<McpServerConfig[]>
      setServers: (servers: McpServerConfig[]) => Promise<void>
      addServer: (server: McpServerConfig) => Promise<void>
      updateServer: (server: McpServerConfig) => Promise<void>
      deleteServer: (id: string) => Promise<void>
      connect: (config: McpServerConfig) => Promise<{
        success: boolean
        error?: string
      }>
      disconnect: (serverId: string) => Promise<void>
      testConnection: (config: McpServerConfig) => Promise<{
        success: boolean
        toolCount?: number
        resourceCount?: number
        promptCount?: number
        error?: string
      }>
      getServerStatuses: () => Promise<McpServerStatus[]>
      getAllTools: () => Promise<McpTool[]>
      getAllResources: () => Promise<McpResource[]>
      getAllPrompts: () => Promise<McpPrompt[]>
      callTool: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<{
        success: boolean
        content?: string
        error?: string
      }>
      readResource: (serverId: string, uri: string) => Promise<{
        success: boolean
        content?: string
        mimeType?: string
        error?: string
      }>
      getPrompt: (serverId: string, promptName: string, args?: Record<string, string>) => Promise<{
        success: boolean
        messages?: Array<{ role: string; content: string }>
        error?: string
      }>
      refreshServer: (serverId: string) => Promise<{
        success: boolean
        error?: string
      }>
      isConnected: (serverId: string) => Promise<boolean>
      connectEnabledServers: () => Promise<Array<{
        id: string
        success: boolean
        error?: string
      }>>
      disconnectAll: () => Promise<void>
      onConnected: (callback: (serverId: string) => void) => () => void
      onDisconnected: (callback: (serverId: string) => void) => () => void
      onError: (callback: (data: { serverId: string; error?: string }) => void) => () => void
      onRefreshed: (callback: (serverId: string) => void) => () => void
    }
    // 知识库操作
    knowledge: {
      initialize: () => Promise<{ success: boolean; error?: string }>
      getSettings: () => Promise<{
        enabled: boolean
        embeddingMode: 'local' | 'mcp'
        localModel: 'auto' | 'lite' | 'standard' | 'large'
        embeddingMcpServerId?: string
        autoSaveUploads: boolean
        chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
        searchTopK: number
        enableRerank: boolean
        mcpKnowledgeServerId?: string
      }>
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
      }>) => Promise<{ success: boolean; error?: string }>
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
      }) => Promise<{
        success: boolean
        docId?: string
        error?: string
        duplicate?: boolean
        existingFilename?: string
      }>
      removeDocument: (docId: string) => Promise<{ success: boolean; error?: string }>
      removeDocuments: (docIds: string[]) => Promise<{ success: boolean; deleted?: number; failed?: number; error?: string }>
      search: (query: string, options?: {
        limit?: number
        hostId?: string
        tags?: string[]
        similarity?: number
        enableRerank?: boolean
      }) => Promise<{
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
      }>
      getHostKnowledge: (hostId: string) => Promise<{
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
      }>
      buildContext: (query: string, options?: { hostId?: string; maxTokens?: number }) => Promise<{
        success: boolean
        context: string
        error?: string
      }>
      getDocuments: () => Promise<Array<{
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
      }>>
      getDocument: (docId: string) => Promise<{
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
      } | undefined>
      getStats: () => Promise<{
        success: boolean
        stats?: {
          documentCount: number
          chunkCount: number
          totalSize: number
          lastUpdated?: number
        }
        error?: string
      }>
      clear: () => Promise<{ success: boolean; error?: string }>
      // 检查知识库初始化是否完成
      isInitialized: () => Promise<boolean>
      // 等待知识库初始化完成
      waitInitialized: () => Promise<boolean>
      isReady: () => Promise<boolean>
      isEnabled: () => Promise<boolean>
      getModels: () => Promise<Array<{
        id: 'lite' | 'standard' | 'large'
        name: string
        huggingfaceId: string
        size: number
        dimensions: number
        bundled: boolean
      }>>
      getModelStatuses: () => Promise<Array<{
        id: 'lite' | 'standard' | 'large'
        available: boolean
        downloading: boolean
        progress?: number
        error?: string
      }>>
      downloadModel: (modelId: 'lite' | 'standard' | 'large') => Promise<{
        success: boolean
        error?: string
      }>
      switchModel: (modelId: 'lite' | 'standard' | 'large') => Promise<{
        success: boolean
        error?: string
      }>
      onDownloadProgress: (callback: (data: {
        modelId: string
        percent: number
        downloaded: number
        total: number
      }) => void) => () => void
      exportData: () => Promise<{
        canceled?: boolean
        success?: boolean
        path?: string
        hasPassword?: boolean
        error?: string
      }>
      importData: () => Promise<{
        canceled?: boolean
        success?: boolean
        imported?: number
        needsPassword?: boolean
        error?: string
      }>
      setPassword: (password: string) => Promise<{
        success: boolean
        error?: string
      }>
      // 监听知识库服务就绪事件
      onReady: (callback: () => void) => () => void
    }
    // 协调器（智能巡检）
    orchestrator: {
      listHosts: () => Promise<Array<{
        hostId: string
        name: string
        host: string
        port: number
        username: string
        group?: string
        groupId?: string
        tags?: string[]
      }>>
      start: (task: string, config?: {
        maxParallelWorkers?: number
        workerTimeout?: number
        autoCloseTerminals?: boolean
        confirmStrategy?: 'cautious' | 'batch' | 'free'
        profileId?: string
      }) => Promise<string>
      stop: (orchestratorId: string) => Promise<void>
      batchConfirmResponse: (
        orchestratorId: string,
        action: 'cancel' | 'current' | 'all',
        selectedTerminals?: string[]
      ) => Promise<void>
      onMessage: (callback: (data: {
        orchestratorId: string
        message: {
          id: string
          type: 'user' | 'agent' | 'system' | 'progress'
          content: string
          timestamp: number
        }
      }) => void) => () => void
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
      }) => void) => () => void
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
      }) => void) => () => void
      onNeedBatchConfirm: (callback: (data: {
        orchestratorId: string
        command: string
        riskLevel: 'safe' | 'moderate' | 'dangerous' | 'blocked'
        targetTerminals: Array<{
          terminalId: string
          terminalName: string
          selected: boolean
        }>
      }) => void) => () => void
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
      }) => void) => () => void
      onError: (callback: (data: {
        orchestratorId: string
        error: string
      }) => void) => () => void
    }
    // 本地文件系统操作
    localFs: {
      getSeparator: () => Promise<string>
      getHomeDir: () => Promise<string>
      getParentDir: (path: string) => Promise<string>
      joinPath: (...paths: string[]) => Promise<string>
      list: (path: string) => Promise<{
        success: boolean
        data?: Array<{
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
        }>
        error?: string
      }>
      mkdir: (path: string) => Promise<{ success: boolean; error?: string }>
      delete: (path: string) => Promise<{ success: boolean; error?: string }>
      rmdir: (path: string) => Promise<{ success: boolean; error?: string }>
      rename: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>
      copyFile: (src: string, dest: string) => Promise<{ success: boolean; error?: string }>
      copyDir: (src: string, dest: string) => Promise<{ success: boolean; error?: string }>
      readFile: (path: string) => Promise<{ success: boolean; data?: string; error?: string }>
      getDrives: () => Promise<Array<{
        name: string
        path: string
        label?: string
        type: 'fixed' | 'removable' | 'network' | 'cdrom' | 'unknown'
      }>>
      getSpecialFolders: () => Promise<Array<{
        name: string
        path: string
        icon: string
      }>>
      showInExplorer: (path: string) => Promise<void>
      openFile: (path: string) => Promise<void>
    }
    // 文件管理器窗口操作
    fileManager: {
      open: (params: {
        sessionId?: string
        sftpConfig?: {
          host: string
          port: number
          username: string
          password?: string
          privateKeyPath?: string
          passphrase?: string
        }
        initialLocalPath?: string
        initialRemotePath?: string
      }) => Promise<void>
      getInitParams: () => Promise<{
        sessionId?: string
        sftpConfig?: {
          host: string
          port: number
          username: string
          password?: string
          privateKeyPath?: string
          passphrase?: string
        }
        initialLocalPath?: string
        initialRemotePath?: string
      } | null>
      onParamsUpdate: (callback: (params: {
        sessionId?: string
        sftpConfig?: {
          host: string
          port: number
          username: string
          password?: string
          privateKeyPath?: string
          passphrase?: string
        }
        initialLocalPath?: string
        initialRemotePath?: string
      }) => void) => () => void
    }
    // 终端屏幕内容服务（主进程请求渲染进程数据）
    screen: {
      // 注册获取最近 N 行的请求处理器
      onRequestLastNLines: (handler: (data: { requestId: string; ptyId: string; lines: number }) => void) => () => void
      // 注册获取可视内容的请求处理器
      onRequestVisibleContent: (handler: (data: { requestId: string; ptyId: string }) => void) => () => void
      // 注册获取屏幕分析的请求处理器
      onRequestScreenAnalysis: (handler: (data: { requestId: string; ptyId: string }) => void) => () => void
      // 响应最近 N 行请求
      responseLastNLines: (requestId: string, lines: string[] | null) => void
      // 响应可视内容请求
      responseVisibleContent: (requestId: string, lines: string[] | null) => void
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
      } | null) => void
    }
  }
}
