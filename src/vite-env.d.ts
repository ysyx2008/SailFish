/// <reference types="vite/client" />

// Steam 版本标识（由 vite define 注入，dev/build 均生效）
declare const __STEAM_BUILD__: boolean

// Vite 环境变量类型声明
interface ImportMetaEnv {
  readonly VITE_STEAM_BUILD?: string  // Steam 版本标识（构建时可用，前端统一用 __STEAM_BUILD__）
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

// 共享类型（从 @shared/types 导入，保持全局可用）
type TerminalType = import('@shared/types').TerminalType
type ExecutionMode = import('@shared/types').ExecutionMode
type IMProcessMode = import('@shared/types').IMProcessMode
type WeChatLoginStatus = import('@shared/types').WeChatLoginStatus
type RemoteChannel = import('@shared/types').RemoteChannel
type RiskLevel = import('@shared/types').RiskLevel
type StepProgress = import('@shared/types').StepProgress
type AgentPlanStep = import('@shared/types').AgentPlanStep
type AgentPlan = import('@shared/types').AgentPlan
type AgentStep = import('@shared/types').AgentStep
type AgentContext = import('@shared/types').AgentContext
type PendingConfirmation = import('@shared/types').PendingConfirmation
type HostProfile = import('@shared/types').HostProfile
type PlanStepStatus = import('@shared/types').PlanStepStatus
type WatchDefinition = import('@shared/types').WatchDefinition
type WatchHistoryRecord = import('@shared/types').WatchHistoryRecord
type TodoItem = import('@shared/types').TodoItem
type TodoStatus = import('@shared/types').TodoStatus
type TodoPriority = import('@shared/types').TodoPriority
type BondMetrics = import('@shared/types').BondMetrics
type BondTrustLevel = import('@shared/types').BondTrustLevel

// 更新状态类型
type UpdateSource = import('@shared/types').UpdateSource
interface UpdateStatusInfo {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  info?: { version?: string; releaseNotes?: string; releaseDate?: string }
  progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number }
  error?: string
  sources?: {
    current: UpdateSource
    recommended: UpdateSource
    latency: Record<UpdateSource, number>
    labels: Record<UpdateSource, { zh: string; en: string }>
  }
}

// MCP 相关类型（与 @shared/types 对齐，避免重复定义）
type McpServerConfig = import('@shared/types').McpServerConfig
type McpConnectErrorKind = import('@shared/types').McpConnectErrorKind

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
  errorKind?: McpConnectErrorKind
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
      getMessagingDocsPath: () => Promise<string>
      notifyMounted: () => void
      onRunTask: (callback: (task: string) => void) => () => void
      onInstallSkill: (callback: (skillId: string) => void) => () => void
      onStartupProgress: (callback: (data: { stage: string }) => void) => () => void
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
      focusWebContents: () => void
      // Windows 自绘标题栏控制
      minimize: () => void
      toggleMaximize: () => void
      isMaximized: () => Promise<boolean>
      onMaximizeStateChange: (callback: (isMaximized: boolean) => void) => () => void
      // Windows 汉堡菜单：弹出应用菜单（frame:false 下原生菜单栏不显示，由此 IPC 替代）
      popupAppMenu: (position?: { x: number; y: number }) => void
      onRequestTerminalCount: (callback: () => void) => () => void
      responseTerminalCount: (count: number) => void
      isFullScreen: () => Promise<boolean>
      onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void
    }
    // 自动更新
    updater: {
      checkForUpdates: () => Promise<{
        success: boolean
        updateInfo?: { version: string; releaseNotes?: string; releaseDate?: string }
        error?: string
      }>
      downloadUpdate: (source?: 'github' | 'oss') => Promise<{
        success: boolean
        source?: 'github' | 'oss'
        error?: string
      }>
      setSource: (source: 'github' | 'oss') => Promise<{
        success: boolean
        error?: string
      }>
      quitAndInstall: () => Promise<{
        success: boolean
        error?: string
      }>
      deferInstall: () => Promise<{
        success: boolean
        error?: string
      }>
      isInstallDeferred: () => Promise<{
        deferred: boolean
        version?: string
      }>
      getStatus: () => Promise<UpdateStatusInfo>
      onStatusChanged: (callback: (status: UpdateStatusInfo) => void) => () => void
    }
    pty: {
      create: (options?: {
        cols?: number
        rows?: number
        cwd?: string
        shell?: string
        env?: Record<string, string>
        encoding?: string
      }) => Promise<{
        id: string
        shellPath: string
        shellKind: 'powershell' | 'cmd' | 'bash'
      }>
      write: (id: string, data: string) => Promise<void>
      resize: (id: string, cols: number, rows: number) => Promise<void>
      dispose: (id: string) => Promise<void>
      executeInTerminal: (id: string, command: string, timeout?: number) => Promise<
        | { status: 'completed'; output: string; duration: number }
        | { status: 'timeout'; output: string; duration: number }
        | { status: 'no_instance'; ptyId: string }
      >
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
      }, options?: { reuseId?: string; attemptId?: string }) => Promise<string>
      /** 中止仍在握手中的连接尝试，返回是否命中 */
      cancelConnect: (attemptId: string) => Promise<boolean>
      write: (id: string, data: string) => Promise<void>
      resize: (id: string, cols: number, rows: number) => Promise<void>
      disconnect: (id: string) => Promise<void>
      onData: (id: string, callback: (data: string) => void) => () => void
      onDisconnected: (id: string, callback: (event: { reason: string; error?: string }) => void) => () => void
    }
    terminalState: {
      init: (id: string, type: TerminalType, initialCwd?: string) => Promise<void>
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
      startExecution: (
        id: string, 
        command: string,
        options?: { source?: 'user' | 'agent'; agentStepTitle?: string }
      ) => Promise<{
        id: string
        terminalId: string
        command: string
        startTime: number
        cwdBefore: string
        status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
        output?: string
        source?: 'user' | 'agent'
        agentStepTitle?: string
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
          /** 命令来源：user=用户输入，agent=AI Agent */
          source?: 'user' | 'agent'
          /** Agent 执行时的步骤标题 */
          agentStepTitle?: string
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
      testApiKey: (profile: Partial<import('@shared/types').AiProfile>) => Promise<{ success: boolean; message: string; latencyMs?: number }>
      fetchModels: (profile: Partial<import('@shared/types').AiProfile>) => Promise<{
        models: Array<import('@shared/types').FetchedAiModel>
        error?: string
      }>
      onProfileFallback: (callback: (notice: {
        requestedId: string
        usedId: string
        usedName: string
      }) => void) => () => void
    }
    config: {
      get: (key: string) => Promise<unknown>
      set: (key: string, value: unknown) => Promise<void>
      getAll: () => Promise<Record<string, unknown>>
      onChanged: (callback: (payload?: { sshSessions?: unknown[]; sessionGroups?: unknown[] }) => void) => () => void
      onUiZoomChanged: (callback: (factor: number) => void) => () => void
      getRecoveryNotice: () => Promise<{
        kind: 'restored' | 'reset'
        from?: string
        at: number
      } | null>
      dismissRecoveryNotice: () => Promise<void>
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
      hasVisionCapability: () => Promise<boolean>
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
      getUiTheme: () => Promise<import('@shared/types').UiThemeName>
      setUiTheme: (theme: import('@shared/types').UiThemeName) => Promise<void>
      getUiThemeMode: () => Promise<import('@shared/types').UiThemeMode>
      setUiThemeMode: (mode: import('@shared/types').UiThemeMode) => Promise<void>
      getSystemColorScheme: () => Promise<import('@shared/types').SystemColorScheme>
      onSystemColorSchemeChanged: (callback: (scheme: import('@shared/types').SystemColorScheme) => void) => () => void
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
      // Agent 调试模式
      getAgentDebugMode: () => Promise<boolean>
      setAgentDebugMode: (enabled: boolean) => Promise<void>
      // 首次设置向导
      getSetupCompleted: () => Promise<boolean>
      setSetupCompleted: (completed: boolean) => Promise<void>
      // Agent 诞生引导
      getAgentOnboardingCompleted: () => Promise<boolean>
      // 语言设置
      getLanguage: () => Promise<string>
      setLanguage: (language: string) => Promise<void>
      // 快捷键
      setKeyboardShortcuts: (shortcuts: Record<string, string>) => Promise<void>
      // 赞助状态
      getSponsorStatus: () => Promise<boolean>
      setSponsorStatus: (status: boolean) => Promise<void>
      // 排序设置
      getSessionSortBy: () => Promise<string>
      setSessionSortBy: (sortBy: string) => Promise<void>
      getDefaultGroupSortOrder: () => Promise<number>
      setDefaultGroupSortOrder: (order: number) => Promise<void>
      // 文件书签
      getFileBookmarks: () => Promise<Array<{
        id: string
        name: string
        path: string
        type: 'local' | 'remote'
        hostId?: string
        hostName?: string
        createdAt: number
      }>>
      addFileBookmark: (bookmark: {
        id: string
        name: string
        path: string
        type: 'local' | 'remote'
        hostId?: string
        hostName?: string
        createdAt: number
      }) => Promise<void>
      deleteFileBookmark: (id: string) => Promise<void>
      updateFileBookmark: (bookmark: {
        id: string
        name: string
        path: string
        type: 'local' | 'remote'
        hostId?: string
        hostName?: string
        createdAt: number
      }) => Promise<void>
      // AI Rules
      getAiRules: () => Promise<string>
      setAiRules: (rules: string) => Promise<void>
      // Agent 个性描述（legacy）
      getAgentPersonalityText: () => Promise<string>
      setAgentPersonalityText: (text: string) => Promise<void>
      // Agent 身份文件（IDENTITY.md / SOUL.md / USER.md）
      readIdentityFile: (filename: string) => Promise<string>
      writeIdentityFile: (filename: string, content: string) => Promise<void>
      // AI 名字
      getAgentName: () => Promise<string>
      setAgentName: (name: string) => Promise<void>
      // AI 头像
      getAgentAvatar: () => Promise<string>
      setAgentAvatar: (dataUrl: string) => Promise<void>
      // 日志级别
      getLogLevel: () => Promise<string>
      setLogLevel: (level: string) => Promise<void>
      // 日志目录
      getLogDir: () => Promise<string | null>
      openLogDir: () => Promise<void>
    }
    diagnostics: {
      getCrashSummary: () => Promise<import('@sailfish/shared-types').CrashSummary>
      getCrashSummaryText: () => Promise<string>
      createPackage: (options?: { chooseLocation?: boolean }) => Promise<import('@sailfish/shared-types').DiagnosticsPackageResult>
      revealPackage: (filePath: string) => Promise<void>
      getNotifyEnabled: () => Promise<boolean>
      setNotifyEnabled: (enabled: boolean) => Promise<void>
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
    // Agent 操作（OOP 重构后统一使用 ptyId）
    agent: {
      run: (
        ptyId: string,
        message: string,
        /** 终端模式必须指明操作哪个窗格 */
        context: AgentContext & { ptyId: string },
        config?: {
          enabled?: boolean
          maxSteps?: number
          commandTimeout?: number
          autoExecuteSafe?: boolean
          autoExecuteModerate?: boolean
          executionMode?: ExecutionMode
        },
        profileId?: string
      ) => Promise<{ success: boolean; result?: string; error?: string; aborted?: boolean }>
      runStandalone: (
        agentId: string,
        message: string,
        context: AgentContext,
        config?: {
          executionMode?: ExecutionMode
          commandTimeout?: number
        },
        profileId?: string
      ) => Promise<{ success: boolean; result?: string; error?: string; aborted?: boolean }>
      abort: (ptyId: string) => Promise<boolean>
      compactContext: (params: {
        agentKey: string
        sessionId?: string
        sessionStartTime?: number
        terminalType: import('@shared/types').TerminalType
        sshHost?: string
        hint?: string
      }) => Promise<
        | { ok: true; freedTokens: number; beforeTokens: number; afterTokens: number }
        | { ok: false; reason: 'running' | 'empty' | 'failed' }
      >
      confirm: (params: {
        ptyId: string
        toolCallId: string
        approved: boolean
        modifiedArgs?: Record<string, unknown>
        alwaysAllow?: boolean
      }) => Promise<boolean>
      getStatus: (ptyId: string) => Promise<unknown>
      cleanup: (ptyId: string) => Promise<void>
      /** 终端重连后同步运行中 Agent 的默认操作 ptyId（agentKey=tabId） */
      remapPtyId: (agentKey: string, oldPtyId: string, newPtyId: string) => Promise<boolean>
      fork: (opts: {
        sourceAgentKey: string
        newAgentId: string
        untilTaskCount?: number
        targetMode?: 'assistant'
        titleSuffix?: string
        sourceSessionId?: string
      }) => Promise<{
        newSessionId: string
        newAgentId: string
        sourceUserTask: string
        newRecord: import('@shared/types').AgentRecord
      } | null>
      forkTask: (opts: {
        sourceAgentKey: string
        newAgentId: string
        untilTaskCount?: number
        titleSuffix?: string
        sourceSessionId?: string
      }) => Promise<{
        newSessionId: string
        newAgentId: string
        sourceUserTask: string
        newRecord: import('@shared/types').AgentRecord
      } | null>
      extractTaskFromCompanion: (opts: {
        newAgentId: string
        anchorTaskIndex?: number
        anchorTaskStepId?: string
        titleSuffix?: string
        sourceSteps?: import('@shared/types').AgentStepRecord[]
      }) => Promise<{
        newSessionId: string
        newAgentId: string
        sourceUserTask: string
        newRecord: import('@shared/types').AgentRecord
      } | null>
      updateConfig: (ptyId: string, config: { executionMode?: ExecutionMode; commandTimeout?: number; profileId?: string }) => Promise<boolean>
      addMessage: (
        ptyId: string,
        message: string,
        attachments?: import('@shared/types').AttachmentInfo[],
        documentContext?: string,
        images?: string[],
        workbenchContext?: import('@shared/types').WorkbenchContext,
        silent?: boolean
      ) => Promise<boolean>
      getExecutionPhase: (ptyId: string) => Promise<{
        phase: 'thinking' | 'executing_command' | 'writing_file' | 'waiting' | 'confirming' | 'idle'
        currentToolName?: string
        canInterrupt: boolean
        interruptWarning?: string
      } | null>
      clearHistory: (ptyId: string) => Promise<void>
      pinSkill: (agentKey: string, skillId: string) => Promise<{
        ok: boolean
        error?: string
        skills: Array<{ id: string; name: string; description?: string; unavailable?: boolean }>
      }>
      unpinSkill: (agentKey: string, skillId: string) => Promise<{
        ok: true
        skills: Array<{ id: string; name: string; description?: string; unavailable?: boolean }>
      }>
      hydrateSkills: (agentKey: string, loadedSkills?: string[], userDismissedSkills?: string[]) => Promise<Array<{ id: string; name: string; description?: string; unavailable?: boolean }>>
      getVisibleSkills: (agentKey: string) => Promise<Array<{ id: string; name: string; description?: string; unavailable?: boolean }>>
      onSkillsChanged: (callback: (data: { agentId: string; skills: Array<{ id: string; name: string; description?: string; unavailable?: boolean }> }) => void) => () => void
      onStep: (callback: (data: { agentId: string; ptyId?: string; step: AgentStep }) => void) => () => void
      onRunning: (callback: (data: { agentId: string; ptyId?: string; userTask: string }) => void) => () => void
      onStepRemoved: (callback: (data: { agentId: string; ptyId?: string; stepId: string }) => void) => () => void
      onContextBar: (callback: (data: { agentId: string; ptyId?: string; contextBar: import('@shared/types').AgentContextBar }) => void) => () => void
      onModelFailover: (callback: (data: {
        agentId: string
        ptyId?: string
        notice: { fromId: string; fromName: string; usedId: string; usedName: string }
      }) => void) => () => void
      onNeedConfirm: (callback: (data: PendingConfirmation & { ptyId?: string }) => void) => () => void
      onConfirmResolved: (callback: (data: { agentId: string; ptyId?: string }) => void) => () => void
      onComplete: (callback: (data: { agentId: string; ptyId?: string; result: string; pendingUserMessages?: Array<string | import('@shared/types').PendingUserHandoff>; aborted?: boolean }) => void) => () => void
      onError: (callback: (data: { agentId: string; ptyId?: string; error: string; aborted?: boolean }) => void) => () => void
      resolveSecureInput: (params: { ptyId: string; requestId: string; value?: string; cancelled?: boolean }) => Promise<boolean>
      onNeedSecureInput: (callback: (data: { agentId: string; requestId: string; prompt: string; skillId: string; envName: string; isUpdate?: boolean; ptyId?: string }) => void) => () => void
    }
    allowlist: {
      getBuiltInRules: () => Promise<{
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
      }>
    }
    commandRules: {
      list: () => Promise<Array<{
        cmd: string
        baseLevel: import('@shared/types/agent').RiskLevel
        writesTo: boolean
        pathMode: 'all' | 'fixed' | 'none'
        safeFlags: string[]
      }>>
      upsert: (payload: {
        cmd: string
        baseLevel: import('@shared/types/agent').RiskLevel
        writesTo?: boolean
        pathMode?: 'all' | 'fixed' | 'none'
        safeFlags?: string | string[]
      }) => Promise<
        | { ok: true; rule: {
            cmd: string
            baseLevel: import('@shared/types/agent').RiskLevel
            writesTo: boolean
            pathMode: 'all' | 'fixed' | 'none'
            safeFlags: string[]
          } }
        | { ok: false; error: string }
      >
      remove: (cmd: string) => Promise<boolean>
      clear: () => Promise<boolean>
    }
    // 历史记录操作
    history: {
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
      getRecentAgentRecords: (limit?: number, excludeWakeup?: boolean) => Promise<Array<{
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
      listAgentSummaries: (excludeWakeup?: boolean) => Promise<Array<{
        id: string
        timestamp: number
        duration: number
        userTask: string
        terminalType: 'local' | 'ssh'
        agentKey?: string
        sshHost?: string
        status: 'completed' | 'failed' | 'aborted'
      }>>
      /** 任务侧栏短标题：首条消息后异步生成，失败返回 null */
      generateConversationTitle: (sessionId: string, userMessage: string, profileId?: string) => Promise<string | null>
      /** 设置会话展示标题（写入会话记录） */
      setConversationTitle: (sessionId: string, title: string, options?: { locked?: boolean }) => Promise<boolean>
      onConversationTitle: (callback: (payload: { sessionId: string; title: string }) => void) => () => void
      searchAgentRecords: (options: {
        keyword?: string
        startDate?: string
        endDate?: string
        limit?: number
        excludeWakeup?: boolean
        titleOnly?: boolean
        requestId?: string
      }) => Promise<{
        records: Array<{
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
        }>
        totalMatched: number
        hasMore: boolean
      }>
      onSearchMatch: (callback: (payload: {
        requestId: string
        summary: import('@shared/types').AgentHistorySummary
      }) => void) => () => void
      abortSearchAgentRecords: () => Promise<void>
      exportHugeJsonlLine: (payload: { sourceFile: string; sourceLine: number }) => Promise<{
        success: boolean
        canceled?: boolean
        error?: string
        bytes?: number
        path?: string
      }>,
      getAgentRecordById: (id: string) => Promise<{
        id: string
        timestamp: number
        userTask: string
        steps: AgentStep[]
        finalResult?: string
        status: 'completed' | 'failed' | 'aborted'
        duration: number
        loadedSkills?: string[]
        userDismissedSkills?: string[]
      } | undefined>
      getRecentByAgentKey: (agentKey: string, limit?: number) => Promise<Array<import('@shared/types').AgentRecord>>
      getCompanionMergedView: () => Promise<import('@shared/types').AgentRecord | undefined>
      deleteAgentRecord: (id: string) => Promise<boolean>
      saveArtifacts: (recordId: string, artifacts: import('@shared/types').CanvasArtifact[]) => Promise<void>
      getStorageStats: () => Promise<{
        chatFiles: number
        agentFiles: number
        agentSessions: number
        totalSize: number
        oldestRecord?: string
        newestRecord?: string
      }>
      getDataPath: () => Promise<string>
      openDataFolder: () => Promise<void>
      cleanup: (days: number) => Promise<{ success: boolean; chatDeleted?: number; agentDeleted?: number; error?: string }>
      getTokenUsageStats: () => Promise<{
        total: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }
        today: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }
        last7Days: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }
        last30Days: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }
        daily: Array<{ date: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number; taskCount: number }>
      }>
    }
    // 数据目录自定义 / 迁移
    dataDir: {
      getInfo: () => Promise<{ current: string; default: string; isCustom: boolean; lastError?: string }>
      hasRunningAgents: () => Promise<boolean>
      pickTarget: () => Promise<{ canceled: boolean; target?: string; nonEmpty?: boolean }>
      migrate: (target: string) => Promise<{ ok: boolean; error?: string }>
      reset: () => Promise<{ ok: boolean; error?: string }>
    }
    // 完整数据备份 / 恢复
    dataBackup: {
      export: () => Promise<{
        success: boolean
        canceled?: boolean
        cancelReason?: 'dialog' | 'overwrite' | 'export'
        path?: string
        files?: number
        totalBytes?: number
        skippedUnreadable?: number
        error?: string
      }>
      cancel: () => Promise<{ ok: boolean }>
      requestRestore: () => Promise<{ success: boolean; canceled?: boolean; error?: string }>
      onProgress: (callback: (data: {
        pct: number
        file: string
        bytes: number
        totalBytes: number
      }) => void) => () => void
    }
    shellCli: {
      status: () => Promise<{
        installed: boolean
        shimPath: string | null
        target: string | null
        binDir: string
        mode: 'packaged' | 'development'
      }>
      install: () => Promise<{
        ok: boolean
        shimPath?: string
        binDir?: string
        error?: string
        pathHint?: boolean
      }>
      uninstall: () => Promise<{ ok: boolean; error?: string }>
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
        extractImages?: boolean
      }) => Promise<{
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
        extractImages?: boolean
        requestId?: string
      }) => Promise<Array<{
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
      }>>
      onParseProgress: (callback: (progress: import('@shared/types').DocumentParseProgress) => void) => () => void
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
        tools?: Array<{ name: string; title?: string; description: string }>
        error?: string
        errorKind?: McpConnectErrorKind
      }>
      /** AI 生成 whenToUse 草稿（须用户确认后写入） */
      suggestWhenToUse: (input: {
        name: string
        tools: Array<{ name: string; title?: string; description?: string }>
      }) => Promise<{
        success: boolean
        whenToUse?: string
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
        enableHostMemory: boolean
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
        enableHostMemory: boolean
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
        error?: string
      }>
      importData: () => Promise<{
        canceled?: boolean
        success?: boolean
        imported?: number
        error?: string
      }>
      saveBackupTo: () => Promise<{
        canceled?: boolean
        success?: boolean
        path?: string
        backupPath?: string
        error?: string
      }>
      restoreFromFolder: () => Promise<{
        canceled?: boolean
        success?: boolean
        backupPath?: string
        error?: string
      }>
      // 监听知识库服务就绪事件
      onReady: (callback: () => void) => () => void
      // 监听知识库索引重建事件（模型升级 / 数据损坏 / 索引缺失）
      onUpgrading: (callback: (data: {
        reason: 'vector' | 'bm25' | 'both' | string
        cause?: 'dimension_mismatch' | 'data_corrupted' | 'missing'
        total?: number
        libraryTotal?: number
      }) => void) => () => void
      // 监听索引重建进度
      onRebuildProgress: (callback: (data: {
        current: number
        total: number
        libraryTotal?: number
        filename: string
      }) => void) => () => void
      // 列出本地备份
      listBackups: () => Promise<{
        success: boolean
        backups?: Array<{
          path: string
          filename: string
          size: number
          createdAt: number
          automatic: boolean
        }>
        error?: string
      }>
      // 创建手动备份
      createBackup: (backupPath?: string) => Promise<{
        success: boolean
        backupPath?: string
        error?: string
      }>
      // 从备份恢复（恢复后自动增量补差集）
      restoreBackup: (backupPath?: string) => Promise<{
        success: boolean
        backupPath?: string
        error?: string
      }>
      // 删除指定备份
      deleteBackup: (backupPath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // ==================== 备份/恢复进度事件 ====================
      onBackupStarted: (callback: (data: { automatic: boolean }) => void) => () => void
      onBackupCompleted: (callback: (data: {
        success: boolean
        backupPath?: string
        error?: string
        skipped?: boolean
      }) => void) => () => void
      onRestoreStarted: (callback: (data: { backupPath?: string }) => void) => () => void
      onRestoreCompleted: (callback: (data: {
        success: boolean
        backupPath?: string
        error?: string
      }) => void) => () => void
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
    // PPT / HTML 产出物预览
    ppt: {
      sanitizePreview: (html: string) => Promise<string>
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
      previewArtifact: (
        filePath: string,
        renderer: import('@shared/types').CanvasRendererType
      ) => Promise<{ success: boolean; data?: string; error?: string }>
      writeFile: (
        filePath: string,
        content: string
      ) => Promise<{ success: boolean; error?: string }>
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
      getFileIcon: (filePath: string) => Promise<{
        success: boolean
        dataUrl?: string
        error?: string
      }>
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
      exists: (filePath: string) => Promise<{ success: boolean; data?: boolean; error?: string }>
    }
    // 产出物 webview 预览（sailfish-artifact:// 协议内容供给 + 截图反馈）
    artifactPreview: {
      sync: (payload: { tabId: string; artifactId: string; content: string }) => Promise<{ success: boolean }>
      clear: (tabId: string, artifactId?: string) => void
      capture: (payload: { webContentsId: number; suggestedName?: string }) => Promise<{
        success: boolean
        data?: { filePath: string; dataUrl: string; width: number; height: number }
        error?: string
      }>
      guestPreloadUrl: () => Promise<string>
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
      close: () => Promise<{ closed: boolean }>
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
    // 菜单命令监听
    menu: {
      onCommand: (callback: (data: { command: string; args: unknown[] }) => void) => () => void
      setTerminalState: (hasTerminal: boolean) => void
      setAiPanelState: (available: boolean) => void
    }
    // 邮箱相关
    email: {
      // 设置邮箱凭据
      setCredential: (accountId: string, credential: string) => Promise<void>
      // 删除邮箱凭据
      deleteCredential: (accountId: string) => Promise<boolean>
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
      }) => Promise<{ success: boolean; message: string }>
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
      }>) => Promise<void>
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
      }) => Promise<{ success: boolean; message: string }>
    }
    // 日历相关
    calendar: {
      // 设置日历凭据
      setCredential: (accountId: string, credential: string) => Promise<void>
      // 删除日历凭据
      deleteCredential: (accountId: string) => Promise<boolean>
      // 测试日历连接
      testConnection: (config: {
        username: string
        password: string
        provider?: string
        serverUrl?: string
      }) => Promise<{ success: boolean; message: string }>
      // 同步日历账户配置到后端
      syncAccounts: (accounts: Array<{
        id: string
        name: string
        provider: string
        username: string
        serverUrl?: string
      }>) => Promise<void>
      // 验证已保存的日历账户连接
      verifyAccount: (account: {
        id: string
        username: string
        provider?: string
        serverUrl?: string
      }) => Promise<{ success: boolean; message: string }>
    }
    // 文件工具
    fileUtils: {
      // 获取拖放文件的路径（Electron 24+ 推荐方式）
      getPathForFile: (file: File) => string
    }
    workspace: {
      savePastedImage: (dataUrl: string, suggestedName?: string) => Promise<{
        success: boolean
        filePath?: string
        error?: string
      }>
      deletePastedImage: (filePath: string) => Promise<{ success: boolean }>
    }
    // 插件系统
    plugin: {
      list: () => Promise<Array<{
        id: string
        name?: string
        description?: string
        version?: string
        enabled: boolean
        toolCount: number
      }>>
      enable: (id: string) => Promise<boolean>
      disable: (id: string) => Promise<boolean>
      install: (spec: string) => Promise<{ success: boolean; pluginId?: string; error?: string }>
      uninstall: (packageName: string) => Promise<{ success: boolean; error?: string }>
      update: (packageName: string) => Promise<{ success: boolean; error?: string }>
      getConfig: (id: string) => Promise<Record<string, unknown>>
      setConfig: (id: string, config: Record<string, unknown>) => Promise<void>
    }
    // 内置技能
    builtinSkill: {
      list: () => Promise<Array<{
        id: string
        name: string
        description: string
        enabled: boolean
      }>>
      toggle: (skillId: string, enabled: boolean) => Promise<boolean>
    }
    // 用户技能操作
    userSkill: {
      list: () => Promise<Array<{
        id: string
        name: string
        description: string
        version?: string
        enabled: boolean
        content: string
        filePath: string
        lastModified: number
      }>>
      refresh: () => Promise<Array<{
        id: string
        name: string
        description: string
        version?: string
        enabled: boolean
        content: string
        filePath: string
        lastModified: number
      }>>
      toggle: (skillId: string, enabled: boolean) => Promise<boolean>
      openFolder: () => Promise<void>
      getContent: (skillId: string) => Promise<string | null>
      getSkillsDir: () => Promise<string>
      getEnvStatus: (skillId: string) => Promise<Array<{ name: string; configured: boolean }>>
      setEnv: (skillId: string, key: string, value: string) => Promise<void>
      deleteEnv: (skillId: string, key: string) => Promise<void>
    }
    // 技能市场
    skillMarket: {
      list: (force?: boolean) => Promise<any[]>
      search: (query: string) => Promise<any[]>
      install: (skillId: string) => Promise<{ success: boolean; error?: string }>
      uninstall: (skillId: string) => Promise<{ success: boolean; error?: string }>
      update: (skillId: string) => Promise<{ success: boolean; error?: string }>
      getRegistryUrl: () => Promise<string>
      setRegistryUrl: (url: string) => Promise<void>
      fetchRegistry: (force?: boolean) => Promise<any>
    }
    // L2 知识文档（结构化持久记忆）
    contextKnowledge: {
      list: () => Promise<{
        success: boolean
        items: Array<{ contextId: string; content: string }>
        maxDocChars: number
        minDocChars: number
        maxDocCharsLimit: number
        error?: string
      }>
      get: (contextId: string) => Promise<{ success: boolean; content: string; error?: string }>
      set: (contextId: string, content: string) => Promise<{ success: boolean; error?: string }>
      delete: (contextId: string) => Promise<{ success: boolean; error?: string }>
      setMaxDocChars: (chars: number) => Promise<{ success: boolean; maxDocChars: number; error?: string }>
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

    // Shell 操作
    shell: {
      openPath: (path: string) => Promise<string>
      showItemInFolder: (path: string) => Promise<void>
    }

    // 语音识别服务
    speech: {
      getModelInfo: () => Promise<{
        id: string
        name: string
        description: string
        languages: string[]
        sampleRate: number
        available: boolean
        packVersion?: string | null
        packSource?: string
        punctuation: {
          id: string
          name: string
          description: string
          available: boolean
        }
      }>
      getPackStatus: () => Promise<{
        available: boolean
        source: 'userData' | 'bundled' | 'none'
        packVersion: string | null
        format: number | null
        supportedFormat: number
        recommendedVersion: string
        approxSizeBytes: number
        installRoot: string | null
        error?: string
      }>
      getPackDownloadUrls: () => Promise<{
        github: string
        oss: string
        version: string
      }>
      installPack: () => Promise<{ success: boolean; status?: unknown; error?: string }>
      importPack: () => Promise<{ success: boolean; cancelled?: boolean; status?: unknown; error?: string }>
      uninstallPack: () => Promise<{ success: boolean; status?: unknown; error?: string }>
      onPackProgress: (callback: (progress: {
        phase: string
        percent: number
        downloaded?: number
        total?: number
        bytesPerSecond?: number
        etaSeconds?: number
        message?: string
      }) => void) => () => void
      isReady: () => Promise<boolean>
      initialize: () => Promise<{
        success: boolean
        error?: string
        hasPunctuation?: boolean
      }>
      transcribe: (audioData: number[], sampleRate: number) => Promise<{
        success: boolean
        result?: {
          text: string
          hasPunctuation?: boolean
        }
        error?: string
      }>
      getStatus: () => Promise<{
        initialized: boolean
        modelLoaded: boolean
        modelId: string | null
        packAvailable?: boolean
      }>
    }

    // TTS 语音合成
    tts: {
      synthesize: (text: string, options?: { voice?: string; model?: string; speed?: number }) => Promise<{
        success: boolean
        audio?: ArrayBuffer
        format?: string
        error?: string
      }>
      getVoices: () => Promise<Array<{
        id: string
        name: string
        language?: string
        gender?: string
        previewUrl?: string
      }>>
      getProviders: () => Promise<Array<{
        id: string
        name: string
      }>>
      stop: () => Promise<void>
    }

    // Web 搜索
    webSearch: {
      updateSettings: (settings: import('@shared/types').WebSearchSettings) => Promise<void>
    }

    llmBenchOpenWindow: () => Promise<void>
    llmBenchListProfiles: () => Promise<Array<{ id: string; name: string; model: string; apiUrl: string; contextLength?: number }>>
    llmBenchGetActiveProfileId: () => Promise<string>
    llmBenchGetLocale: () => Promise<'zh-CN' | 'en-US'>
    llmBenchGetSuiteInfo: () => Promise<{ suiteVersion: string; rungs: number[]; shotChoices: number[]; defaultShots: number }>
    llmBenchStart: (input: { profileId: string; rungs?: number[]; shots?: number }) => Promise<{ ok: boolean; error?: string }>
    llmBenchStop: () => Promise<boolean>
    llmBenchIsRunning: () => Promise<boolean>
    llmBenchGetReport: () => Promise<unknown>
    llmBenchSaveReport: () => Promise<{ saved: boolean; filePath?: string }>
    llmBenchWriteClipboard: (text: string) => Promise<boolean>
    onLlmBenchProgress: (callback: (progress: unknown) => void) => () => void

    // AI Debug 调试窗口
    aiDebugOpenWindow: () => Promise<void>
    aiDebugCloseWindow: () => Promise<{ closed: boolean }>
    aiDebugIsWindowOpen: () => Promise<boolean>
    aiDebugGetLogs: () => Promise<Array<{
      id: string
      type: string
      timestamp: number
      requestId: string
      profileId?: string
      model?: string
      data: unknown
    }>>
    aiDebugClearLogs: () => Promise<boolean>
    aiDebugGetLogFilePath: () => Promise<string | null>
    aiDebugGetLogDir: () => Promise<string>
    aiDebugExportLogs: (filePath: string) => Promise<{ success: boolean; error?: string }>
    aiDebugCopyEntry: (entryId: string) => Promise<string | null>
    aiDebugWriteClipboard: (text: string) => Promise<void>
    /** 写入图片到原生剪贴板（PNG/JPEG 等二进制 buffer）。绕开浏览器 Clipboard API 的权限/焦点限制。 */
    writeImageToClipboard: (buffer: ArrayBuffer | Uint8Array) => Promise<void>
    /** 弹原生"保存为"对话框写图片到磁盘。filters 顺序 = 优先级（第一项默认）。 */
    saveImageWithDialog: (payload: {
      defaultName: string
      filters: Array<{ label: string; extensions: string[] }>
      buffers: Record<string, ArrayBuffer | string>
    }) => Promise<{ saved: boolean; filePath?: string; filename?: string }>
    onAiDebugMessage: (callback: (message: { type: string; entry?: unknown }) => void) => () => void

    // 定时任务调度
    scheduler: {
      getTasks: () => Promise<Array<{
        id: string
        name: string
        description?: string
        enabled: boolean
        schedule: {
          type: 'cron' | 'interval' | 'once'
          expression: string
        }
        prompt: string
        target: {
          type: 'local' | 'ssh' | 'assistant'
          sshSessionId?: string
          sshSessionName?: string
          workingDirectory?: string
        }
        options: {
          timeout: number
          requireConfirm: boolean
          notifyOnComplete: boolean
          notifyOnError: boolean
        }
        createdAt: number
        updatedAt: number
        lastRun?: {
          at: number
          status: 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'
          duration: number
          output?: string
          error?: string
        }
        nextRun?: number
      }>>
      getTask: (id: string) => Promise<{
        id: string
        name: string
        description?: string
        enabled: boolean
        schedule: {
          type: 'cron' | 'interval' | 'once'
          expression: string
        }
        prompt: string
        target: {
          type: 'local' | 'ssh' | 'assistant'
          sshSessionId?: string
          sshSessionName?: string
          workingDirectory?: string
        }
        options: {
          timeout: number
          requireConfirm: boolean
          notifyOnComplete: boolean
          notifyOnError: boolean
        }
        createdAt: number
        updatedAt: number
        lastRun?: {
          at: number
          status: 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'
          duration: number
          output?: string
          error?: string
        }
        nextRun?: number
      } | null>
      createTask: (params: {
        name: string
        description?: string
        schedule: {
          type: 'cron' | 'interval' | 'once'
          expression: string
        }
        prompt: string
        target: {
          type: 'local' | 'ssh' | 'assistant'
          sshSessionId?: string
          sshSessionName?: string
          workingDirectory?: string
        }
        options?: Partial<{
          timeout: number
          requireConfirm: boolean
          notifyOnComplete: boolean
          notifyOnError: boolean
        }>
        enabled?: boolean
      }) => Promise<{
        id: string
        name: string
        description?: string
        enabled: boolean
        schedule: {
          type: 'cron' | 'interval' | 'once'
          expression: string
        }
        prompt: string
        target: {
          type: 'local' | 'ssh' | 'assistant'
          sshSessionId?: string
          sshSessionName?: string
          workingDirectory?: string
        }
        options: {
          timeout: number
          requireConfirm: boolean
          notifyOnComplete: boolean
          notifyOnError: boolean
        }
        createdAt: number
        updatedAt: number
        lastRun?: {
          at: number
          status: 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'
          duration: number
          output?: string
          error?: string
        }
        nextRun?: number
      }>
      updateTask: (id: string, params: {
        name?: string
        description?: string
        schedule?: {
          type: 'cron' | 'interval' | 'once'
          expression: string
        }
        prompt?: string
        target?: {
          type: 'local' | 'ssh' | 'assistant'
          sshSessionId?: string
          sshSessionName?: string
          workingDirectory?: string
        }
        options?: Partial<{
          timeout: number
          requireConfirm: boolean
          notifyOnComplete: boolean
          notifyOnError: boolean
        }>
        enabled?: boolean
      }) => Promise<{
        id: string
        name: string
        description?: string
        enabled: boolean
        schedule: {
          type: 'cron' | 'interval' | 'once'
          expression: string
        }
        prompt: string
        target: {
          type: 'local' | 'ssh' | 'assistant'
          sshSessionId?: string
          sshSessionName?: string
          workingDirectory?: string
        }
        options: {
          timeout: number
          requireConfirm: boolean
          notifyOnComplete: boolean
          notifyOnError: boolean
        }
        createdAt: number
        updatedAt: number
        lastRun?: {
          at: number
          status: 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'
          duration: number
          output?: string
          error?: string
        }
        nextRun?: number
      } | null>
      deleteTask: (id: string) => Promise<boolean>
      toggleTask: (id: string) => Promise<{
        id: string
        name: string
        prompt: string
        schedule: string
        enabled: boolean
        targetType: 'local' | 'ssh' | 'assistant'
        sshSessionId?: string
        sshSessionName?: string
        createdAt: number
        updatedAt: number
        lastRun?: {
          at: number
          status: 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'
          duration: number
          output?: string
          error?: string
        }
        nextRun?: number
      } | null>
      runTask: (id: string) => Promise<{
        success: boolean
        output: string
        error?: string
        duration: number
        steps?: unknown[]
      }>
      getHistory: (taskId?: string, limit?: number) => Promise<Array<{
        id: string
        taskId: string
        taskName: string
        at: number
        status: 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'
        duration: number
        output?: string
        error?: string
      }>>
      clearHistory: (taskId?: string) => Promise<number>
      getSshSessions: () => Promise<Array<{
        id: string
        name: string
        host: string
        port: number
        username: string
      }>>
      isTaskRunning: (id: string) => Promise<boolean>
      getRunningTasks: () => Promise<string[]>
      onTaskStarted: (callback: (data: { 
        taskId: string
        ptyId: string | null
        taskName: string
        prompt: string
        targetType: 'local' | 'ssh' | 'assistant'
        sshSessionId?: string
        sshSessionName?: string
      }) => void) => () => void
      onTaskCompleted: (callback: (data: { taskId: string; result: { success: boolean; output: string; error?: string; duration: number; steps?: unknown[] } }) => void) => () => void
    }

    // 堡垒机（JumpServer）集成
    bastion: {
      getConfig: () => Promise<{ url: string; username: string; password: string; autoJumpHost: boolean; jumpHostPort: number; rejectUnauthorized: boolean }>
      saveConfig: (config: { url: string; username: string; password: string; autoJumpHost: boolean; jumpHostPort: number; rejectUnauthorized: boolean }) => Promise<void>
      testConnection: (config: { url: string; username: string; password: string; rejectUnauthorized: boolean }) => Promise<{ success: boolean; message: string; assetCount?: number }>
      syncAssets: () => Promise<{ success: boolean; error?: string; added: number; updated: number; removed: number; total: number; groupId: string; groupName: string }>
    }

    // Gateway 远程访问
    gateway: {
      start: (config: { enabled: boolean; port: number; apiToken: string; host: string }) => Promise<{ success: boolean; error?: string }>
      stop: () => Promise<{ success: boolean }>
      getConfig: () => Promise<{ enabled: boolean; port: number; apiToken: string; host: string }>
      isRunning: () => Promise<boolean>
      getAutoStart: () => Promise<boolean>
      setAutoStart: (enabled: boolean) => Promise<void>
      onRemoteTabCreated: (callback: (data: {
        agentId: string
        title: string
      }) => void) => () => void
      onRemoteTaskStarted: (callback: (data: {
        agentId: string
        message: string
        remoteChannel?: RemoteChannel
      }) => void) => () => void
      getAuditLog: (limit?: number) => Promise<Array<{
        id: string
        timestamp: number
        type: string
        clientIp?: string
        summary: string
        details?: Record<string, unknown>
      }>>
      onAuditLog: (callback: (entry: {
        id: string
        timestamp: number
        type: string
        clientIp?: string
        summary: string
        details?: Record<string, unknown>
      }) => void) => () => void
    }

    // Web Chat 会话（运行时配置）
    webChat: {
      setExecutionMode: (mode: ExecutionMode) => Promise<void>
    }

    // 本地待办面板
    todo: {
      list: (filter?: { status?: TodoStatus | 'all'; includeDone?: boolean }) => Promise<TodoItem[]>
      create: (input: {
        title: string
        description?: string
        status?: TodoStatus
        priority?: TodoPriority
        dueDate?: string
        tags?: string[]
      }) => Promise<TodoItem>
      update: (id: string, patch: {
        title?: string
        description?: string | null
        status?: TodoStatus
        priority?: TodoPriority | null
        dueDate?: string | null
        tags?: string[] | null
      }) => Promise<TodoItem | null>
      complete: (id: string) => Promise<TodoItem | null>
      delete: (id: string) => Promise<boolean>
      countOverdue: () => Promise<number>
      appendJournal: (id: string, entry: Omit<import('@shared/types').TodoJournalEntry, 'id' | 'at'>) => Promise<TodoItem | null>
      addSource: (id: string, source: Omit<import('@shared/types').TodoSource, 'id' | 'at'>) => Promise<TodoItem | null>
      buildHandoffPrompt: (id: string, kind: 'handle' | 'schedule', minutes?: number) => Promise<string | null>
      onChanged: (callback: () => void) => () => void
    }

    // Watch & Sensor（感知层）
    watch: {
      getAll: () => Promise<WatchDefinition[]>
      get: (id: string) => Promise<WatchDefinition | null>
      create: (params: Record<string, unknown>) => Promise<WatchDefinition>
      update: (id: string, updates: Record<string, unknown>) => Promise<WatchDefinition | null>
      delete: (id: string) => Promise<boolean>
      toggle: (id: string) => Promise<WatchDefinition | null>
      trigger: (id: string) => Promise<void>
      getHistory: (watchId?: string, limit?: number) => Promise<WatchHistoryRecord[]>
      clearHistory: (watchId?: string) => Promise<void>
      isRunning: (id: string) => Promise<boolean>
      getRunning: () => Promise<string[]>
      cancel: (id: string) => Promise<boolean>
      getSshSessions: () => Promise<Array<{ id: string; name: string; host: string; port: number; username: string }>>
      getTemplates: () => Promise<Array<{ id: string; name: string; nameEn: string; description: string; descriptionEn: string; category: string; icon: string }>>
      getTemplateCategories: () => Promise<string[]>
      createFromTemplate: (templateId: string, options?: Record<string, unknown>) => Promise<WatchDefinition | null>
      resetHeartbeat: () => Promise<boolean>
      onTaskStarted?: (callback: (data: { watchId: string; ptyId?: string; watchName?: string; executionType?: string }) => void) => () => void
      onTaskCompleted?: (callback: (data: { watchId: string; result?: { success: boolean; skipped?: boolean; error?: string } }) => void) => () => void
      onEnsureTab: (callback: (data: { agentId: string }) => void) => () => void
      onProactiveMessage: (callback: (data: { agentId: string; message: string; watchName: string }) => void) => () => void
      onActivateMessage?: (callback: (data: { agentId: string }) => void) => () => void
    }
    sensor: {
      getStatus: () => Promise<Array<{ id: string; name: string; running: boolean; details?: Record<string, unknown> }>>
      getStatusDetailed?: () => Promise<Array<{ id: string; name: string; running: boolean; details?: Record<string, unknown> }>>
      getRecentEvents: (limit?: number) => Promise<Array<{ id: string; type: string; source: string; timestamp: number }>>
      setHeartbeat: (enabled: boolean, intervalMinutes?: number) => Promise<void>
      setAwakened: (awakened: boolean, intervalMinutes?: number) => Promise<void>
      triggerHeartbeat: () => Promise<void>
    }
    auth: {
      getSession: () => Promise<import('@shared/types').AuthPublicSession | null>
      getAccessToken: () => Promise<string | null>
      getGateMode: () => Promise<'hard' | 'soft' | 'none'>
      /** 一条龙弹窗登录，返回脱敏会话 */
      startLogin: () => Promise<import('@shared/types').AuthPublicSession>
      completeLogin: (code: string, state: string) => Promise<import('@shared/types').AuthPublicSession>
      logout: () => Promise<void>
    }

    // IM 集成
    im: {
      startDingTalk: (config: { enabled: boolean; clientId: string; clientSecret: string }) => Promise<{ success: boolean; error?: string }>
      stopDingTalk: () => Promise<{ success: boolean }>
      startFeishu: (config: { enabled: boolean; appId: string; appSecret: string }) => Promise<{ success: boolean; error?: string }>
      stopFeishu: () => Promise<{ success: boolean }>
      startSlack: (config: { enabled: boolean; botToken: string; appToken: string }) => Promise<{ success: boolean; error?: string }>
      stopSlack: () => Promise<{ success: boolean }>
      startTelegram: (config: { enabled: boolean; botToken: string }) => Promise<{ success: boolean; error?: string }>
      stopTelegram: () => Promise<{ success: boolean }>
      startWeCom: (config: { enabled: boolean; botId: string; secret: string }) => Promise<{ success: boolean; error?: string }>
      stopWeCom: () => Promise<{ success: boolean }>
      wechatLogin: () => Promise<{ success: boolean; qrcodeUrl?: string; error?: string }>
      cancelWeChatLogin: () => Promise<{ success: boolean }>
      startWeChat: () => Promise<{ success: boolean; error?: string }>
      stopWeChat: () => Promise<{ success: boolean }>
      wechatLogout: () => Promise<{ success: boolean }>
      getStatus: () => Promise<{
        dingtalk: { enabled: boolean; connected: boolean }
        feishu: { enabled: boolean; connected: boolean }
        slack: { enabled: boolean; connected: boolean }
        telegram: { enabled: boolean; connected: boolean }
        wecom: { enabled: boolean; connected: boolean }
        wechat: { enabled: boolean; connected: boolean }
      }>
      getConfig: () => Promise<{
        dingtalk: { clientId: string; clientSecret: string; autoConnect: boolean }
        feishu: { appId: string; appSecret: string; autoConnect: boolean }
        slack: { botToken: string; appToken: string; autoConnect: boolean }
        telegram: { botToken: string; autoConnect: boolean }
        wecom: { botId: string; secret: string; autoConnect: boolean }
        wechat: { hasToken: boolean; autoConnect: boolean }
        executionMode: ExecutionMode
        processMode: IMProcessMode
        sendThinkingProcess: boolean
      }>
      setAutoConnect: (platform: string, enabled: boolean) => Promise<void>
      setExecutionMode: (mode: ExecutionMode) => Promise<void>
      setProcessMode: (mode: IMProcessMode) => Promise<void>
      setSendThinkingProcess: (enabled: boolean) => Promise<void>
      sendNotification: (text: string, options?: { markdown?: boolean; title?: string }) => Promise<{ success: boolean; platform?: string; error?: string }>
      sendFileToChannel: (platform: string, filePath: string, fileName?: string) => Promise<{ success: boolean; error?: string }>
      getChannelSendTargets: () => Promise<Array<{
        platform: string
        connected: boolean
        hasContact: boolean
        contactName?: string
      }>>
      onConnectionChange: (callback: (data: { platform: string; connected: boolean }) => void) => () => void
      onWeChatLoginStatus: (callback: (status: WeChatLoginStatus) => void) => () => void
      onSendFailure: (callback: (data: { platform: string; userId?: string; userName?: string; reason?: string }) => void) => () => void
    }

    feishuOAuth: {
      startOAuth: () => Promise<{ authorized: boolean; userName?: string; openId?: string; error?: string }>
      revokeOAuth: () => Promise<{ success: boolean; error?: string }>
      getOAuthStatus: () => Promise<{ authorized: boolean; userName?: string; openId?: string; expiresAt?: number }>
    }

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
      ) => () => void
      sendResult: (id: string, result: { ok: boolean; data?: unknown; error?: string }) => void
    }

    quit: {
      onToast: (callback: (payload: { show: boolean }) => void) => () => void
    }

    workbench: {
      onExec: (
        handler: (
          id: string,
          op: { type: 'list_artifacts' },
          ownerAgentKey?: string
        ) => void
      ) => () => void
      sendResult: (id: string, result: { ok: boolean; data?: unknown; error?: string }) => void
    }

    browserBridge: {
      getStatus: () => Promise<import('@shared/types/browser-bridge').BrowserBridgeStatus>
      install: () => Promise<import('@shared/types/browser-bridge').BrowserBridgeInstallStatus>
      uninstall: () => Promise<{ errors: string[] }>
      openExtensionGuide: (browser: import('@shared/types/browser-bridge').BrowserBridgeBrowser) => Promise<void>
      onConnectionsChanged: (
        callback: (status: import('@shared/types/browser-bridge').BrowserBridgeStatus) => void
      ) => () => void
    }
    // 羁绊（Bond）
    bond: {
      getMetrics: () => Promise<BondMetrics>
      getMilestones: () => Promise<string[]>
      recalculate: () => Promise<{ newMilestones?: string[]; metrics?: BondMetrics }>
    }
  }
}
