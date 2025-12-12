import { app, BrowserWindow, ipcMain, shell, Menu, dialog } from 'electron'
import path, { join } from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'

// 开发模式下禁用硬件加速，避免热重载时 GPU 进程崩溃
// 这个调用必须在 app.whenReady() 之前
if (!app.isPackaged) {
  app.disableHardwareAcceleration()
  console.log('[Main] 开发模式：已禁用硬件加速以防止热重载崩溃')
}

// 读取 package.json 获取版本号（开发模式下 app.getVersion() 返回 Electron 版本）
const packageJson = JSON.parse(fs.readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const APP_VERSION = packageJson.version

/**
 * 修复 macOS/Linux GUI 应用的 PATH 环境变量问题
 * 当应用作为 GUI 应用启动时（双击 .app 或从 Dock/Spotlight 启动），
 * 不会加载用户的 shell 配置文件，导致 PATH 缺少开发工具路径
 */
function fixPath(): void {
  // Windows 不需要修复
  if (process.platform === 'win32') return
  
  // 开发模式下通常从终端启动，已有正确的 PATH
  // 但为了一致性，仍然执行修复
  
  try {
    const userShell = process.env.SHELL || '/bin/zsh'
    
    // 从用户的 login shell 获取完整的 PATH
    // -l: login shell，会加载 .zshrc/.bashrc/.profile 等配置
    // -i: interactive shell（某些配置只在交互模式下加载）
    // -c: 执行命令
    const shellPath = execSync(`${userShell} -l -i -c 'echo -n $PATH'`, {
      encoding: 'utf8',
      timeout: 5000,
      // 避免触发 TTY 相关问题
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    
    if (shellPath && shellPath !== process.env.PATH) {
      // 合并路径：用户 shell 的 PATH + 当前 PATH（去重）
      const currentPaths = (process.env.PATH || '').split(':')
      const shellPaths = shellPath.split(':')
      const allPaths = [...new Set([...shellPaths, ...currentPaths])]
      process.env.PATH = allPaths.join(':')
      
      console.log('[Main] PATH 已修复，添加了用户 shell 的路径')
    }
  } catch (error) {
    // 如果获取失败，手动添加常见的开发工具路径
    console.warn('[Main] 无法从 shell 获取 PATH，使用备用方案:', error)
    
    const homeDir = process.env.HOME || ''
    const commonPaths = [
      '/usr/local/bin',                          // Homebrew (Intel)
      '/opt/homebrew/bin',                       // Homebrew (Apple Silicon)
      '/opt/homebrew/sbin',
      `${homeDir}/.nvm/versions/node/*/bin`,     // nvm (通配符，需要展开)
      `${homeDir}/.volta/bin`,                   // Volta
      `${homeDir}/.cargo/bin`,                   // Rust/Cargo
      `${homeDir}/.local/bin`,                   // pipx, poetry 等
      '/usr/local/go/bin',                       // Go
      `${homeDir}/go/bin`,                       // Go workspace
    ]
    
    // 展开 nvm 路径中的通配符
    const expandedPaths: string[] = []
    for (const p of commonPaths) {
      if (p.includes('*')) {
        try {
          const basePath = p.substring(0, p.indexOf('*'))
          if (fs.existsSync(basePath)) {
            const dirs = fs.readdirSync(basePath)
            for (const dir of dirs) {
              const fullPath = p.replace('*', dir)
              if (fs.existsSync(fullPath)) {
                expandedPaths.push(fullPath)
              }
            }
          }
        } catch {
          // 忽略展开错误
        }
      } else if (fs.existsSync(p)) {
        expandedPaths.push(p)
      }
    }
    
    if (expandedPaths.length > 0) {
      const currentPaths = (process.env.PATH || '').split(':')
      const allPaths = [...new Set([...expandedPaths, ...currentPaths])]
      process.env.PATH = allPaths.join(':')
      console.log('[Main] PATH 备用修复完成，添加了常见开发工具路径')
    }
  }
}

// 在 app 模块加载后立即修复 PATH（越早越好）
fixPath()
import { PtyService } from './services/pty.service'
import { SshService } from './services/ssh.service'
import { AiService } from './services/ai.service'
import { ConfigService, McpServerConfig } from './services/config.service'
import { XshellImportService } from './services/xshell-import.service'
import { AgentService, AgentStep, PendingConfirmation, AgentContext } from './services/agent'
import { HistoryService, ChatRecord, AgentRecord } from './services/history.service'
import { HostProfileService, HostProfile } from './services/host-profile.service'
import { getDocumentParserService, UploadedFile, ParseOptions, ParsedDocument } from './services/document-parser.service'
import { SftpService, SftpConfig } from './services/sftp.service'
import { McpService } from './services/mcp.service'
import { getKnowledgeService, KnowledgeService } from './services/knowledge'
import type { KnowledgeSettings, SearchOptions, AddDocumentOptions, ModelTier } from './services/knowledge/types'
import { initTerminalStateService, getTerminalStateService, type TerminalState, type CwdChangeEvent, type CommandExecution, type CommandExecutionEvent } from './services/terminal-state.service'
import { initTerminalAwarenessService, getTerminalAwarenessService, type TerminalAwareness } from './services/terminal-awareness'
import { initScreenContentService } from './services/screen-content.service'

// 禁用 GPU 加速可能导致的问题（可选）
// app.disableHardwareAcceleration()

// 禁用开发模式下的安全警告（CSP unsafe-eval 是 Vite 热更新所需）
// 打包后的生产版本不会有这个警告
if (process.env.VITE_DEV_SERVER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
}

// 捕获未处理的异常，防止 EPIPE 等错误导致崩溃
process.on('uncaughtException', (error) => {
  // 忽略 EPIPE 错误（管道关闭时的正常错误）
  if (error.message?.includes('EPIPE') || error.message?.includes('read EPIPE')) {
    return
  }
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (reason) => {
  // 忽略 EPIPE 相关的 Promise 拒绝
  if (String(reason).includes('EPIPE')) {
    return
  }
  console.error('Unhandled rejection:', reason)
})

let mainWindow: BrowserWindow | null = null

// 服务实例
const ptyService = new PtyService()
const sshService = new SshService()
const aiService = new AiService()
const configService = new ConfigService()
const xshellImportService = new XshellImportService()
const hostProfileService = new HostProfileService()
const mcpService = new McpService()
const agentService = new AgentService(aiService, ptyService, hostProfileService, mcpService, configService, sshService)
const historyService = new HistoryService()
const documentParserService = getDocumentParserService()
const sftpService = new SftpService()

// 终端状态服务（CWD 追踪、命令状态等）
const terminalStateService = initTerminalStateService(ptyService, sshService)

// 终端感知服务（整合屏幕分析和进程监控）
const terminalAwarenessService = initTerminalAwarenessService(ptyService, terminalStateService, sshService)

// 监听 CWD 变化，转发到前端
terminalStateService.onCwdChange((event: CwdChangeEvent) => {
  mainWindow?.webContents.send('terminal:cwdChange', event)
})

// 监听命令执行事件，转发到前端
terminalStateService.onCommandExecution((event: CommandExecutionEvent) => {
  mainWindow?.webContents.send('terminal:commandExecution', event)
})

// 知识库服务（延迟初始化，需要其他服务已就绪）
let knowledgeService: KnowledgeService | null = null
function getKnowledge(): KnowledgeService {
  if (!knowledgeService) {
    knowledgeService = getKnowledgeService(configService, aiService, mcpService)
    if (!knowledgeService) {
      throw new Error('Failed to initialize KnowledgeService')
    }
  }
  return knowledgeService
}

// 在应用启动时初始化知识库服务（确保 Agent 可以访问）
async function initKnowledgeService(): Promise<void> {
  try {
    knowledgeService = getKnowledgeService(configService, aiService, mcpService)
    
    // 如果知识库已启用，初始化服务（加载向量数据）
    if (knowledgeService.isEnabled()) {
      await knowledgeService.initialize()
    }
    
    console.log('[Main] KnowledgeService initialized')
  } catch (e) {
    console.error('[Main] Failed to initialize KnowledgeService:', e)
  }
}

// MCP 服务事件转发
mcpService.on('connected', (serverId: string) => {
  mainWindow?.webContents.send('mcp:connected', serverId)
})
mcpService.on('disconnected', (serverId: string) => {
  mainWindow?.webContents.send('mcp:disconnected', serverId)
})
mcpService.on('error', (data: { serverId: string; error?: string }) => {
  mainWindow?.webContents.send('mcp:error', data)
})
mcpService.on('refreshed', (serverId: string) => {
  mainWindow?.webContents.send('mcp:refreshed', serverId)
})

function createWindow() {
  // 根据平台选择图标
  const iconPath = process.platform === 'darwin'
    ? join(__dirname, '../resources/icon.icns')
    : process.platform === 'win32'
      ? join(__dirname, '../resources/icon.ico')
      : join(__dirname, '../resources/icon.png')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: `旗鱼终端 v${APP_VERSION}`,
    icon: iconPath,
    frame: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 开发环境加载本地服务器
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    // 生产环境加载打包后的文件
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  // 在浏览器中打开外部链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 拦截页面内链接点击，防止应用内导航到外部网页
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 允许开发环境的热更新导航
    if (process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL)) {
      return
    }
    // 允许导航到本地文件（生产环境）
    if (url.startsWith('file://')) {
      return
    }
    // 阻止导航到外部 URL，改为在系统浏览器中打开
    event.preventDefault()
    shell.openExternal(url)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// 应用准备就绪
app.whenReady().then(async () => {
  // 移除默认菜单栏
  Menu.setApplicationMenu(null)

  // 初始化知识库服务（确保 Agent 可以访问）
  await initKnowledgeService()
  
  // 初始化屏幕内容服务（供 Agent 获取准确的终端输出）
  initScreenContentService()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// 所有窗口关闭时退出应用（Windows & Linux）
app.on('window-all-closed', () => {
  // 清理所有 PTY、SSH、SFTP 和 MCP 连接
  ptyService.disposeAll()
  sshService.disposeAll()
  sftpService.disconnectAll()
  mcpService.disconnectAll()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ==================== IPC 处理器 ====================

// PTY 相关
ipcMain.handle('pty:create', async (_event, options) => {
  return ptyService.create(options)
})

ipcMain.handle('pty:write', async (_event, id: string, data: string) => {
  ptyService.write(id, data)
})

ipcMain.handle('pty:resize', async (_event, id: string, cols: number, rows: number) => {
  ptyService.resize(id, cols, rows)
})

ipcMain.handle('pty:executeInTerminal', async (_event, id: string, command: string, timeout?: number) => {
  return ptyService.executeInTerminal(id, command, timeout)
})

ipcMain.handle('pty:dispose', async (_event, id: string) => {
  ptyService.dispose(id)
})

// PTY 数据输出 - 转发到渲染进程
ipcMain.on('pty:subscribe', (event, id: string) => {
  ptyService.onData(id, (data: string) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`pty:data:${id}`, data)
      }
      // 追踪本地终端输出（用于检测命令是否在运行）
      // 计算行数（包括 \n 和 \r 都算换行，适用于 curl 进度条等）
      const lineCount = (data.match(/[\n\r]/g) || []).length
      terminalAwarenessService.trackOutput(id, lineCount, data.length)
    } catch (e) {
      // 忽略发送错误（窗口可能已关闭）
    }
  })
})

// SSH 相关
ipcMain.handle('ssh:connect', async (_event, config) => {
  return sshService.connect(config)
})

ipcMain.handle('ssh:write', async (_event, id: string, data: string) => {
  sshService.write(id, data)
})

ipcMain.handle('ssh:resize', async (_event, id: string, cols: number, rows: number) => {
  sshService.resize(id, cols, rows)
})

ipcMain.handle('ssh:disconnect', async (_event, id: string) => {
  // 清理订阅
  const unsubscribe = sshDataUnsubscribes.get(id)
  if (unsubscribe) {
    unsubscribe()
    sshDataUnsubscribes.delete(id)
  }
  const disconnectUnsub = sshDisconnectUnsubscribes.get(id)
  if (disconnectUnsub) {
    disconnectUnsub()
    sshDisconnectUnsubscribes.delete(id)
  }
  sshService.disconnect(id)
})

// SSH 数据订阅的取消函数存储
const sshDataUnsubscribes = new Map<string, () => void>()
// SSH 断开连接订阅的取消函数存储
const sshDisconnectUnsubscribes = new Map<string, () => void>()

ipcMain.on('ssh:subscribe', (event, id: string) => {
  // 注册数据回调
  const dataUnsubscribe = sshService.onData(id, (data: string) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ssh:data:${id}`, data)
      }
      // 追踪 SSH 终端输出（用于检测命令是否在运行）
      // 计算行数（包括 \n 和 \r 都算换行，适用于 curl 进度条等）
      const lineCount = (data.match(/[\n\r]/g) || []).length
      terminalAwarenessService.trackOutput(id, lineCount, data.length)
    } catch (e) {
      // 忽略发送错误（窗口可能已关闭）
    }
  })
  sshDataUnsubscribes.set(id, dataUnsubscribe)

  // 注册断开连接回调，通知前端
  const disconnectUnsubscribe = sshService.onDisconnect(id, (disconnectEvent) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ssh:disconnected:${id}`, {
          reason: disconnectEvent.reason,
          error: disconnectEvent.error?.message
        })
      }
    } catch (e) {
      // 忽略发送错误
    }
    // 清理订阅
    sshDataUnsubscribes.delete(id)
    sshDisconnectUnsubscribes.delete(id)
  })
  sshDisconnectUnsubscribes.set(id, disconnectUnsubscribe)
})

// SSH 取消订阅
ipcMain.on('ssh:unsubscribe', (_event, id: string) => {
  const dataUnsubscribe = sshDataUnsubscribes.get(id)
  if (dataUnsubscribe) {
    dataUnsubscribe()
    sshDataUnsubscribes.delete(id)
  }
  const disconnectUnsubscribe = sshDisconnectUnsubscribes.get(id)
  if (disconnectUnsubscribe) {
    disconnectUnsubscribe()
    sshDisconnectUnsubscribes.delete(id)
  }
})

// ==================== 终端状态服务 ====================

// 初始化终端状态
ipcMain.handle('terminalState:init', async (_event, id: string, type: 'local' | 'ssh', initialCwd?: string) => {
  terminalStateService.initTerminal(id, type, initialCwd)
})

// 移除终端状态
ipcMain.handle('terminalState:remove', async (_event, id: string) => {
  terminalStateService.removeTerminal(id)
})

// 获取终端状态
ipcMain.handle('terminalState:get', async (_event, id: string): Promise<TerminalState | undefined> => {
  return terminalStateService.getState(id)
})

// 获取当前工作目录
ipcMain.handle('terminalState:getCwd', async (_event, id: string): Promise<string> => {
  return terminalStateService.getCwd(id)
})

// 刷新 CWD（执行 pwd 命令验证）
ipcMain.handle('terminalState:refreshCwd', async (_event, id: string): Promise<string> => {
  return terminalStateService.refreshCwd(id, 'pwd_check')
})

// 手动更新 CWD
ipcMain.handle('terminalState:updateCwd', async (_event, id: string, newCwd: string) => {
  terminalStateService.updateCwd(id, newCwd)
})

// 处理用户输入（追踪可能的 CWD 变化）
ipcMain.handle('terminalState:handleInput', async (_event, id: string, input: string) => {
  terminalStateService.handleInput(id, input)
})

// 获取终端空闲状态
ipcMain.handle('terminalState:getIdleState', async (_event, id: string): Promise<boolean> => {
  const state = terminalStateService.getState(id)
  return state?.isIdle ?? true
})

// ==================== 命令执行追踪 ====================

// 开始追踪命令执行
ipcMain.handle('terminalState:startExecution', async (_event, id: string, command: string): Promise<CommandExecution | null> => {
  return terminalStateService.startCommandExecution(id, command)
})

// 追加命令输出
ipcMain.handle('terminalState:appendOutput', async (_event, id: string, output: string) => {
  terminalStateService.appendCommandOutput(id, output)
})

// 完成命令执行
ipcMain.handle('terminalState:completeExecution', async (
  _event,
  id: string,
  exitCode?: number,
  status?: 'completed' | 'failed' | 'timeout' | 'cancelled'
): Promise<CommandExecution | null> => {
  return terminalStateService.completeCommandExecution(id, exitCode, status)
})

// 获取当前正在执行的命令
ipcMain.handle('terminalState:getCurrentExecution', async (_event, id: string): Promise<CommandExecution | undefined> => {
  return terminalStateService.getCurrentExecution(id)
})

// 获取命令执行历史
ipcMain.handle('terminalState:getExecutionHistory', async (_event, id: string, limit?: number): Promise<CommandExecution[]> => {
  return terminalStateService.getExecutionHistory(id, limit)
})

// 获取最后一次命令执行
ipcMain.handle('terminalState:getLastExecution', async (_event, id: string): Promise<CommandExecution | undefined> => {
  return terminalStateService.getLastExecution(id)
})

// 清除命令执行历史
ipcMain.handle('terminalState:clearExecutionHistory', async (_event, id: string) => {
  terminalStateService.clearExecutionHistory(id)
})

// ==================== 终端感知服务 ====================

// 获取终端感知状态（综合分析）
ipcMain.handle('terminalAwareness:getAwareness', async (_event, ptyId: string): Promise<TerminalAwareness> => {
  return terminalAwarenessService.getAwareness(ptyId)
})

// 追踪输出（用于输出速率计算）
ipcMain.handle('terminalAwareness:trackOutput', async (_event, ptyId: string, lineCount: number) => {
  terminalAwarenessService.trackOutput(ptyId, lineCount)
})

// 获取终端可视区域内容
ipcMain.handle('terminalAwareness:getVisibleContent', async (_event, ptyId: string): Promise<string[] | null> => {
  return terminalAwarenessService.getVisibleContent(ptyId)
})

// 检查是否可以执行命令
ipcMain.handle('terminalAwareness:canExecute', async (_event, ptyId: string): Promise<boolean> => {
  return terminalAwarenessService.canExecute(ptyId)
})

// 获取执行命令前的建议
ipcMain.handle('terminalAwareness:getPreExecutionAdvice', async (_event, ptyId: string, command: string) => {
  return terminalAwarenessService.getPreExecutionAdvice(ptyId, command)
})

// 清理终端感知数据
ipcMain.handle('terminalAwareness:clear', async (_event, ptyId: string) => {
  terminalAwarenessService.clearTerminal(ptyId)
})

// AI 相关
ipcMain.handle('ai:chat', async (_event, messages, profileId?: string) => {
  return aiService.chat(messages, profileId)
})

ipcMain.handle('ai:chatStream', async (event, messages, profileId?: string, requestId?: string) => {
  // 使用传入的 requestId 或生成新的 streamId
  const streamId = requestId || Date.now().toString()
  aiService.chatStream(
    messages,
    (chunk: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ai:stream:${streamId}`, { chunk })
      }
    },
    () => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ai:stream:${streamId}`, { done: true })
      }
    },
    (error: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ai:stream:${streamId}`, { error })
      }
    },
    profileId,
    streamId  // 传递 requestId 给 AI 服务
  )
  return streamId
})

ipcMain.handle('ai:abort', async (_event, requestId?: string) => {
  aiService.abort(requestId)
})

// 应用信息
ipcMain.handle('app:getVersion', async () => {
  return APP_VERSION
})

// 配置相关
ipcMain.handle('config:get', async (_event, key: string) => {
  return configService.get(key)
})

ipcMain.handle('config:set', async (_event, key: string, value: unknown) => {
  configService.set(key, value)
})

ipcMain.handle('config:getAll', async () => {
  return configService.getAll()
})

// AI 配置
ipcMain.handle('config:getAiProfiles', async () => {
  return configService.getAiProfiles()
})

ipcMain.handle('config:setAiProfiles', async (_event, profiles) => {
  configService.setAiProfiles(profiles)
})

ipcMain.handle('config:getActiveAiProfile', async () => {
  return configService.getActiveAiProfile()
})

ipcMain.handle('config:setActiveAiProfile', async (_event, profileId: string) => {
  configService.setActiveAiProfile(profileId)
})

// SSH 会话配置
ipcMain.handle('config:getSshSessions', async () => {
  return configService.getSshSessions()
})

ipcMain.handle('config:setSshSessions', async (_event, sessions) => {
  configService.setSshSessions(sessions)
})

// 会话分组配置
ipcMain.handle('config:getSessionGroups', async () => {
  return configService.getSessionGroups()
})

ipcMain.handle('config:setSessionGroups', async (_event, groups) => {
  configService.setSessionGroups(groups)
})

// 主题配置
ipcMain.handle('config:getTheme', async () => {
  return configService.getTheme()
})

ipcMain.handle('config:setTheme', async (_event, theme: string) => {
  configService.setTheme(theme)
})

// UI 主题配置
ipcMain.handle('config:getUiTheme', async () => {
  return configService.getUiTheme()
})

ipcMain.handle('config:setUiTheme', async (_event, theme: string) => {
  configService.setUiTheme(theme as 'dark' | 'light' | 'blue' | 'sponsor-gold' | 'sponsor-sakura' | 'sponsor-forest')
})

// Agent MBTI 配置
ipcMain.handle('config:getAgentMbti', async () => {
  return configService.getAgentMbti()
})

ipcMain.handle('config:setAgentMbti', async (_event, mbti: string | null) => {
  configService.setAgentMbti(mbti as import('./services/config.service').AgentMbtiType)
})

// 首次设置向导
ipcMain.handle('config:getSetupCompleted', async () => {
  return configService.getSetupCompleted()
})

ipcMain.handle('config:setSetupCompleted', async (_event, completed: boolean) => {
  configService.setSetupCompleted(completed)
})

// 语言设置
ipcMain.handle('config:getLanguage', async () => {
  return configService.getLanguage()
})

ipcMain.handle('config:setLanguage', async (_event, language: string) => {
  configService.setLanguage(language as import('./services/config.service').LocaleType)
})

ipcMain.handle('config:getSponsorStatus', async () => {
  return configService.getSponsorStatus()
})

ipcMain.handle('config:setSponsorStatus', async (_event, status: boolean) => {
  configService.setSponsorStatus(status)
})

// Xshell 导入相关
ipcMain.handle('xshell:selectFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择 Xshell 会话文件',
    filters: [
      { name: 'Xshell 会话文件', extensions: ['xsh'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, filePaths: [] }
  }
  
  return { canceled: false, filePaths: result.filePaths }
})

ipcMain.handle('xshell:selectDirectory', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择 Xshell 会话目录',
    properties: ['openDirectory']
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, dirPath: '' }
  }
  
  return { canceled: false, dirPath: result.filePaths[0] }
})

ipcMain.handle('xshell:importFiles', async (_event, filePaths: string[]) => {
  return xshellImportService.importFiles(filePaths)
})

ipcMain.handle('xshell:importDirectory', async (_event, dirPath: string) => {
  return xshellImportService.importFromDirectory(dirPath)
})

ipcMain.handle('xshell:scanDefaultPaths', async () => {
  return xshellImportService.scanDefaultPaths()
})

// ==================== Agent 相关 ====================

// 运行 Agent
ipcMain.handle('agent:run', async (event, { ptyId, message, context, config, profileId }: {
  ptyId: string
  message: string
  context: AgentContext
  config?: object
  profileId?: string
}) => {
  // 设置事件回调，将 Agent 事件转发到渲染进程
  // 使用 JSON.parse(JSON.stringify()) 确保对象可序列化
  // 在事件中携带 ptyId，前端可以用它可靠地匹配 tab
  agentService.setCallbacks({
    onStep: (agentId: string, step: AgentStep) => {
      if (!event.sender.isDestroyed()) {
        // 序列化 step 对象，确保可以通过 IPC 传递
        const serializedStep = JSON.parse(JSON.stringify(step))
        event.sender.send('agent:step', { agentId, ptyId, step: serializedStep })
      }
    },
    onNeedConfirm: (confirmation: PendingConfirmation) => {
      if (!event.sender.isDestroyed()) {
        // 只发送可序列化的字段，不包含 resolve 函数
        event.sender.send('agent:needConfirm', {
          agentId: confirmation.agentId,
          ptyId,
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel
        })
      }
    },
    onComplete: (agentId: string, result: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:complete', { agentId, ptyId, result })
      }
    },
    onError: (agentId: string, error: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:error', { agentId, ptyId, error })
      }
    }
  })

  try {
    const result = await agentService.run(ptyId, message, context, config, profileId)
    return { success: true, result }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '未知错误' 
    }
  }
})

// 中止 Agent
ipcMain.handle('agent:abort', async (_event, agentId: string) => {
  return agentService.abort(agentId)
})

// 确认工具调用
ipcMain.handle('agent:confirm', async (_event, { agentId, toolCallId, approved, modifiedArgs }: {
  agentId: string
  toolCallId: string
  approved: boolean
  modifiedArgs?: Record<string, unknown>
}) => {
  return agentService.confirmToolCall(agentId, toolCallId, approved, modifiedArgs)
})

// 获取 Agent 状态
ipcMain.handle('agent:getStatus', async (_event, agentId: string) => {
  return agentService.getRunStatus(agentId)
})

// 清理 Agent 运行记录
ipcMain.handle('agent:cleanup', async (_event, agentId: string) => {
  agentService.cleanup(agentId)
})

// 更新 Agent 配置（如严格模式）
ipcMain.handle('agent:updateConfig', async (_event, agentId: string, config: { strictMode?: boolean; commandTimeout?: number }) => {
  return agentService.updateConfig(agentId, config)
})

// 添加用户补充消息（Agent 执行过程中）
ipcMain.handle('agent:addMessage', async (_event, agentId: string, message: string) => {
  return agentService.addUserMessage(agentId, message)
})

// ==================== 历史记录相关 ====================

// 保存聊天记录
ipcMain.handle('history:saveChatRecord', async (_event, record: ChatRecord) => {
  historyService.saveChatRecord(record)
})

// 批量保存聊天记录
ipcMain.handle('history:saveChatRecords', async (_event, records: ChatRecord[]) => {
  historyService.saveChatRecords(records)
})

// 获取聊天记录
ipcMain.handle('history:getChatRecords', async (_event, startDate?: string, endDate?: string) => {
  return historyService.getChatRecords(startDate, endDate)
})

// 保存 Agent 记录
ipcMain.handle('history:saveAgentRecord', async (_event, record: AgentRecord) => {
  historyService.saveAgentRecord(record)
})

// 获取 Agent 记录
ipcMain.handle('history:getAgentRecords', async (_event, startDate?: string, endDate?: string) => {
  return historyService.getAgentRecords(startDate, endDate)
})

// 获取数据目录路径
ipcMain.handle('history:getDataPath', async () => {
  return historyService.getDataPath()
})

// 获取存储统计
ipcMain.handle('history:getStorageStats', async () => {
  return historyService.getStorageStats()
})

// 导出数据
ipcMain.handle('history:exportData', async () => {
  const configData = configService.getAll()
  const hostProfiles = hostProfileService.getAllProfiles()
  return historyService.exportData(configData, hostProfiles)
})

// 导入数据（单文件）
ipcMain.handle('history:importData', async (_event, data: { version: string; exportTime: number; config: object; history: { chat: ChatRecord[]; agent: AgentRecord[] }; hostProfiles?: unknown[] }) => {
  // 先导入历史记录
  const historyResult = historyService.importData(data)
  if (!historyResult.success) {
    return historyResult
  }

  // 导入主机档案
  if (historyResult.hostProfiles && historyResult.hostProfiles.length > 0) {
    hostProfileService.importProfiles(historyResult.hostProfiles as HostProfile[])
  }

  // 导入配置（需要用户确认是否覆盖）
  // 这里只返回成功，配置的导入由前端单独处理
  return { success: true, configIncluded: !!data.config, hostProfilesImported: historyResult.hostProfiles?.length || 0 }
})

// 导出到文件夹
ipcMain.handle('history:exportToFolder', async (_event, options?: { includeSshPasswords?: boolean; includeApiKeys?: boolean }) => {
  try {
    // 检查 mainWindow 是否存在
    if (!mainWindow) {
      return { success: false, error: '窗口未就绪' }
    }
    
    // 选择导出目录 - createDirectory 仅在 macOS 上有效
    const dialogOptions: Electron.OpenDialogOptions = {
      title: '选择导出目录',
      properties: ['openDirectory'],
      buttonLabel: '导出到此目录'
    }
    
    // macOS 上添加 createDirectory 选项
    if (process.platform === 'darwin') {
      dialogOptions.properties!.push('createDirectory')
    }
    
    const result = await dialog.showOpenDialog(mainWindow, dialogOptions)
    
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, canceled: true }
    }
    
    // 创建子目录
    const exportDir = path.join(result.filePaths[0], `sfterm-backup-${new Date().toISOString().split('T')[0]}`)
    
    const configData = configService.getAll()
    const hostProfiles = hostProfileService.getAllProfiles()
    
    return historyService.exportToFolder(exportDir, configData, hostProfiles, options)
  } catch (error) {
    console.error('导出到文件夹失败:', error)
    return { success: false, error: error instanceof Error ? error.message : '导出失败' }
  }
})

// 从文件夹导入
ipcMain.handle('history:importFromFolder', async () => {
  try {
    // 检查 mainWindow 是否存在
    if (!mainWindow) {
      return { success: false, error: '窗口未就绪' }
    }
    
    // 选择导入目录
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择备份文件夹',
      properties: ['openDirectory'],
      buttonLabel: '导入此目录'
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, canceled: true }
    }
    
    const importResult = historyService.importFromFolder(result.filePaths[0])
  
  if (importResult.success) {
    // 导入主机档案
    if (importResult.hostProfiles && importResult.hostProfiles.length > 0) {
      hostProfileService.importProfiles(importResult.hostProfiles as HostProfile[])
    }
    
    // 应用配置（合并而非覆盖）
    if (importResult.config) {
      const currentConfig = configService.getAll()
      
      // SSH 会话：合并（按 ID 去重）
      if (importResult.config.sshSessions) {
        const existingSessions = currentConfig.sshSessions || []
        const newSessions = importResult.config.sshSessions as Array<{ id: string; [key: string]: unknown }>
        const mergedSessions = [...existingSessions]
        for (const session of newSessions) {
          if (!mergedSessions.some(s => s.id === session.id)) {
            mergedSessions.push(session as typeof existingSessions[0])
          }
        }
        configService.set('sshSessions', mergedSessions)
      }
      
      // AI Profiles：合并（按 ID 去重）
      if (importResult.config.aiProfiles) {
        const existingProfiles = currentConfig.aiProfiles || []
        const newProfiles = importResult.config.aiProfiles as Array<{ id: string; [key: string]: unknown }>
        const mergedProfiles = [...existingProfiles]
        for (const profile of newProfiles) {
          if (!mergedProfiles.some(p => p.id === profile.id)) {
            mergedProfiles.push(profile as typeof existingProfiles[0])
          }
        }
        configService.set('aiProfiles', mergedProfiles)
      }
      
      // 其他设置：如果当前为默认值则覆盖
      if (importResult.config.theme) {
        configService.set('theme', importResult.config.theme as string)
      }
      if (importResult.config.terminalSettings) {
        configService.set('terminalSettings', importResult.config.terminalSettings as typeof currentConfig.terminalSettings)
      }
    }
  }
  
  return importResult
  } catch (error) {
    console.error('从文件夹导入失败:', error)
    return { success: false, imported: [], error: error instanceof Error ? error.message : '导入失败' }
  }
})

// 清理旧记录
ipcMain.handle('history:cleanup', async (_event, daysToKeep: number) => {
  return historyService.cleanupOldRecords(daysToKeep)
})

// 在文件管理器中打开数据目录
ipcMain.handle('history:openDataFolder', async () => {
  const dataPath = historyService.getDataPath()
  shell.openPath(dataPath)
})

// ==================== 主机档案相关 ====================

// 获取主机档案
ipcMain.handle('hostProfile:get', async (_event, hostId: string) => {
  return hostProfileService.getProfile(hostId)
})

// 获取所有主机档案
ipcMain.handle('hostProfile:getAll', async () => {
  return hostProfileService.getAllProfiles()
})

// 更新主机档案
ipcMain.handle('hostProfile:update', async (_event, hostId: string, updates: Partial<HostProfile>) => {
  return hostProfileService.updateProfile(hostId, updates)
})

// 添加笔记
ipcMain.handle('hostProfile:addNote', async (_event, hostId: string, note: string) => {
  hostProfileService.addNote(hostId, note)
})

// 删除主机档案
ipcMain.handle('hostProfile:delete', async (_event, hostId: string) => {
  hostProfileService.deleteProfile(hostId)
})

// 获取探测命令
ipcMain.handle('hostProfile:getProbeCommands', async (_event, os: string) => {
  return hostProfileService.getProbeCommands(os)
})

// 解析探测结果
ipcMain.handle('hostProfile:parseProbeOutput', async (_event, output: string, hostId?: string) => {
  const existingProfile = hostId ? hostProfileService.getProfile(hostId) : null
  return hostProfileService.parseProbeOutput(output, existingProfile)
})

// 生成主机 ID
ipcMain.handle('hostProfile:generateHostId', async (_event, type: 'local' | 'ssh', sshHost?: string, sshUser?: string) => {
  return hostProfileService.generateHostId(type, sshHost, sshUser)
})

// 检查是否需要探测
ipcMain.handle('hostProfile:needsProbe', async (_event, hostId: string) => {
  return hostProfileService.needsProbe(hostId)
})

// 后台探测本地主机（不在终端显示）
ipcMain.handle('hostProfile:probeLocal', async () => {
  return hostProfileService.probeAndUpdateLocal()
})

// 生成主机上下文（用于 System Prompt）
ipcMain.handle('hostProfile:generateContext', async (_event, hostId: string) => {
  return hostProfileService.generateHostContext(hostId)
})

// SSH 主机探测
ipcMain.handle('hostProfile:probeSsh', async (_event, sshId: string, hostId: string) => {
  try {
    // 通过 SSH 执行探测命令
    const probeOutput = await sshService.probe(sshId)
    
    // 解析探测结果
    const existingProfile = hostProfileService.getProfile(hostId)
    const probeResult = hostProfileService.parseProbeOutput(probeOutput, existingProfile)
    
    // 更新档案
    const updatedProfile = hostProfileService.updateProfile(hostId, {
      ...probeResult,
      lastProbed: Date.now()
    })
    
    return updatedProfile
  } catch (error) {
    console.error('[SSH Probe] 探测失败:', error)
    return null
  }
})

// ==================== 文档解析相关 ====================

// 选择文件对话框
ipcMain.handle('document:selectFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择文档',
    filters: [
      { name: '支持的文档', extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'json', 'xml', 'html', 'csv'] },
      { name: 'PDF 文档', extensions: ['pdf'] },
      { name: 'Word 文档', extensions: ['docx', 'doc'] },
      { name: '文本文件', extensions: ['txt', 'md'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, files: [] }
  }
  
  // 获取文件信息
  const files: UploadedFile[] = result.filePaths.map(filePath => {
    const stats = fs.statSync(filePath)
    return {
      name: path.basename(filePath),
      path: filePath,
      size: stats.size
    }
  })
  
  return { canceled: false, files }
})

// 解析单个文档
ipcMain.handle('document:parse', async (_event, file: UploadedFile, options?: ParseOptions) => {
  return documentParserService.parseDocument(file, options)
})

// 批量解析文档
ipcMain.handle('document:parseMultiple', async (_event, files: UploadedFile[], options?: ParseOptions) => {
  return documentParserService.parseDocuments(files, options)
})

// 格式化为 AI 上下文
ipcMain.handle('document:formatAsContext', async (_event, docs: ParsedDocument[]) => {
  return documentParserService.formatAsContext(docs)
})

// 生成文档摘要
ipcMain.handle('document:generateSummary', async (_event, doc: ParsedDocument) => {
  return documentParserService.generateSummary(doc)
})

// 检查解析能力
ipcMain.handle('document:checkCapabilities', async () => {
  return documentParserService.checkCapabilities()
})

// 获取支持的文件类型
ipcMain.handle('document:getSupportedTypes', async () => {
  return documentParserService.getSupportedTypes()
})

// ==================== SFTP 相关 ====================

// SFTP 传输进度事件转发
sftpService.on('transfer-start', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-start', progress)
})
sftpService.on('transfer-progress', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-progress', progress)
})
sftpService.on('transfer-complete', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-complete', progress)
})
sftpService.on('transfer-error', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-error', progress)
})

// 连接 SFTP
ipcMain.handle('sftp:connect', async (_event, sessionId: string, config: SftpConfig) => {
  try {
    await sftpService.connect(sessionId, config)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '连接失败' 
    }
  }
})

// 断开 SFTP 连接
ipcMain.handle('sftp:disconnect', async (_event, sessionId: string) => {
  await sftpService.disconnect(sessionId)
})

// 检查连接是否存在
ipcMain.handle('sftp:hasSession', async (_event, sessionId: string) => {
  return sftpService.hasSession(sessionId)
})

// 列出目录内容
ipcMain.handle('sftp:list', async (_event, sessionId: string, remotePath: string) => {
  try {
    const list = await sftpService.list(sessionId, remotePath)
    return { success: true, data: list }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '列出目录失败' 
    }
  }
})

// 获取当前工作目录
ipcMain.handle('sftp:pwd', async (_event, sessionId: string) => {
  try {
    const cwd = await sftpService.pwd(sessionId)
    return { success: true, data: cwd }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '获取工作目录失败' 
    }
  }
})

// 检查路径是否存在
ipcMain.handle('sftp:exists', async (_event, sessionId: string, remotePath: string) => {
  try {
    const result = await sftpService.exists(sessionId, remotePath)
    return { success: true, data: result }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '检查路径失败' 
    }
  }
})

// 获取文件/目录信息
ipcMain.handle('sftp:stat', async (_event, sessionId: string, remotePath: string) => {
  try {
    const stats = await sftpService.stat(sessionId, remotePath)
    return { success: true, data: stats }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '获取文件信息失败' 
    }
  }
})

// 上传文件
ipcMain.handle('sftp:upload', async (_event, sessionId: string, localPath: string, remotePath: string, transferId: string) => {
  try {
    await sftpService.upload(sessionId, localPath, remotePath, transferId)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '上传失败' 
    }
  }
})

// 下载文件
ipcMain.handle('sftp:download', async (_event, sessionId: string, remotePath: string, localPath: string, transferId: string) => {
  try {
    await sftpService.download(sessionId, remotePath, localPath, transferId)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '下载失败' 
    }
  }
})

// 上传目录
ipcMain.handle('sftp:uploadDir', async (_event, sessionId: string, localDir: string, remoteDir: string) => {
  try {
    await sftpService.uploadDir(sessionId, localDir, remoteDir)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '上传目录失败' 
    }
  }
})

// 下载目录
ipcMain.handle('sftp:downloadDir', async (_event, sessionId: string, remoteDir: string, localDir: string) => {
  try {
    await sftpService.downloadDir(sessionId, remoteDir, localDir)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '下载目录失败' 
    }
  }
})

// 创建目录
ipcMain.handle('sftp:mkdir', async (_event, sessionId: string, remotePath: string) => {
  try {
    await sftpService.mkdir(sessionId, remotePath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '创建目录失败' 
    }
  }
})

// 删除文件
ipcMain.handle('sftp:delete', async (_event, sessionId: string, remotePath: string) => {
  try {
    await sftpService.delete(sessionId, remotePath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '删除文件失败' 
    }
  }
})

// 删除目录
ipcMain.handle('sftp:rmdir', async (_event, sessionId: string, remotePath: string) => {
  try {
    await sftpService.rmdir(sessionId, remotePath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '删除目录失败' 
    }
  }
})

// 重命名/移动
ipcMain.handle('sftp:rename', async (_event, sessionId: string, oldPath: string, newPath: string) => {
  try {
    await sftpService.rename(sessionId, oldPath, newPath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '重命名失败' 
    }
  }
})

// 修改权限
ipcMain.handle('sftp:chmod', async (_event, sessionId: string, remotePath: string, mode: string | number) => {
  try {
    await sftpService.chmod(sessionId, remotePath, mode)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '修改权限失败' 
    }
  }
})

// 读取文本文件
ipcMain.handle('sftp:readFile', async (_event, sessionId: string, remotePath: string) => {
  try {
    const content = await sftpService.readFile(sessionId, remotePath)
    return { success: true, data: content }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '读取文件失败' 
    }
  }
})

// 写入文本文件
ipcMain.handle('sftp:writeFile', async (_event, sessionId: string, remotePath: string, content: string) => {
  try {
    await sftpService.writeFile(sessionId, remotePath, content)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '写入文件失败' 
    }
  }
})

// 获取当前传输列表
ipcMain.handle('sftp:getTransfers', async () => {
  return sftpService.getTransfers()
})

// 选择本地文件（用于上传）
ipcMain.handle('sftp:selectLocalFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择要上传的文件',
    properties: ['openFile', 'multiSelections']
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, files: [] }
  }
  
  const files = result.filePaths.map(filePath => {
    const stats = fs.statSync(filePath)
    return {
      name: path.basename(filePath),
      path: filePath,
      size: stats.size,
      isDirectory: stats.isDirectory()
    }
  })
  
  return { canceled: false, files }
})

// 选择本地目录（用于上传或保存下载）
ipcMain.handle('sftp:selectLocalDirectory', async (_event, options?: { title?: string; forSave?: boolean }) => {
  const dialogOptions: Electron.OpenDialogOptions = {
    title: options?.title || '选择目录',
    properties: ['openDirectory']
  }
  
  // macOS 上允许创建新目录
  if (process.platform === 'darwin') {
    dialogOptions.properties!.push('createDirectory')
  }
  
  const result = await dialog.showOpenDialog(dialogOptions)
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, path: '' }
  }
  
  return { canceled: false, path: result.filePaths[0] }
})

// 选择保存文件路径
ipcMain.handle('sftp:selectSavePath', async (_event, defaultName: string) => {
  const result = await dialog.showSaveDialog({
    title: '保存文件',
    defaultPath: defaultName,
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  
  if (result.canceled || !result.filePath) {
    return { canceled: true, path: '' }
  }
  
  return { canceled: false, path: result.filePath }
})

// ==================== MCP 相关 ====================

// 获取 MCP 服务器配置列表
ipcMain.handle('mcp:getServers', async () => {
  return configService.getMcpServers()
})

// 保存 MCP 服务器配置列表
ipcMain.handle('mcp:setServers', async (_event, servers: McpServerConfig[]) => {
  configService.setMcpServers(servers)
})

// 添加 MCP 服务器
ipcMain.handle('mcp:addServer', async (_event, server: McpServerConfig) => {
  configService.addMcpServer(server)
})

// 更新 MCP 服务器
ipcMain.handle('mcp:updateServer', async (_event, server: McpServerConfig) => {
  configService.updateMcpServer(server)
})

// 删除 MCP 服务器
ipcMain.handle('mcp:deleteServer', async (_event, id: string) => {
  // 先断开连接
  await mcpService.disconnect(id)
  configService.deleteMcpServer(id)
})

// 连接到 MCP 服务器
ipcMain.handle('mcp:connect', async (_event, config: McpServerConfig) => {
  try {
    await mcpService.connect(config)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '连接失败' 
    }
  }
})

// 断开 MCP 服务器连接
ipcMain.handle('mcp:disconnect', async (_event, serverId: string) => {
  await mcpService.disconnect(serverId)
})

// 测试 MCP 服务器连接
ipcMain.handle('mcp:testConnection', async (_event, config: McpServerConfig) => {
  return mcpService.testConnection(config)
})

// 获取所有已连接服务器的状态
ipcMain.handle('mcp:getServerStatuses', async () => {
  return mcpService.getServerStatuses()
})

// 获取所有可用工具
ipcMain.handle('mcp:getAllTools', async () => {
  return mcpService.getAllTools()
})

// 获取所有可用资源
ipcMain.handle('mcp:getAllResources', async () => {
  return mcpService.getAllResources()
})

// 获取所有可用提示模板
ipcMain.handle('mcp:getAllPrompts', async () => {
  return mcpService.getAllPrompts()
})

// 调用 MCP 工具
ipcMain.handle('mcp:callTool', async (_event, serverId: string, toolName: string, args: Record<string, unknown>) => {
  return mcpService.callTool(serverId, toolName, args)
})

// 读取 MCP 资源
ipcMain.handle('mcp:readResource', async (_event, serverId: string, uri: string) => {
  return mcpService.readResource(serverId, uri)
})

// 获取 MCP 提示模板
ipcMain.handle('mcp:getPrompt', async (_event, serverId: string, promptName: string, args?: Record<string, string>) => {
  return mcpService.getPrompt(serverId, promptName, args)
})

// 刷新服务器的工具/资源/提示列表
ipcMain.handle('mcp:refreshServer', async (_event, serverId: string) => {
  try {
    await mcpService.refreshServer(serverId)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '刷新失败' 
    }
  }
})

// 检查服务器是否已连接
ipcMain.handle('mcp:isConnected', async (_event, serverId: string) => {
  return mcpService.isConnected(serverId)
})

// 连接所有启用的 MCP 服务器
ipcMain.handle('mcp:connectEnabledServers', async () => {
  const servers = configService.getEnabledMcpServers()
  const results: Array<{ id: string; success: boolean; error?: string }> = []
  
  for (const server of servers) {
    try {
      await mcpService.connect(server)
      results.push({ id: server.id, success: true })
    } catch (error) {
      results.push({ 
        id: server.id, 
        success: false, 
        error: error instanceof Error ? error.message : '连接失败' 
      })
    }
  }
  
  return results
})

// 断开所有 MCP 连接
ipcMain.handle('mcp:disconnectAll', async () => {
  await mcpService.disconnectAll()
})

// ==================== 知识库相关 ====================

// 初始化知识库服务
ipcMain.handle('knowledge:initialize', async () => {
  try {
    const service = getKnowledge()
    await service.initialize()
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '初始化失败' 
    }
  }
})

// 获取知识库设置
ipcMain.handle('knowledge:getSettings', async () => {
  return getKnowledge().getSettings()
})

// 更新知识库设置
ipcMain.handle('knowledge:updateSettings', async (_event, settings: Partial<KnowledgeSettings>) => {
  try {
    await getKnowledge().updateSettings(settings)
    return { success: true }
  } catch (error) {
    console.error('[Knowledge] 更新设置失败:', error)
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '更新设置失败' 
    }
  }
})

// 添加文档到知识库
ipcMain.handle('knowledge:addDocument', async (_event, doc: ParsedDocument, options?: AddDocumentOptions) => {
  try {
    const knowledgeService = getKnowledge()
    
    // 先检查是否重复
    const duplicateCheck = knowledgeService.isDuplicate(doc.content)
    if (duplicateCheck.isDuplicate && duplicateCheck.existingDoc) {
      return { 
        success: true, 
        docId: duplicateCheck.existingDoc.id,
        duplicate: true,
        existingFilename: duplicateCheck.existingDoc.filename
      }
    }
    
    const docId = await knowledgeService.addDocument(doc, options)
    return { success: true, docId, duplicate: false }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '添加文档失败' 
    }
  }
})

// 删除文档
ipcMain.handle('knowledge:removeDocument', async (_event, docId: string) => {
  try {
    const result = await getKnowledge().removeDocument(docId)
    return { success: result }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '删除文档失败' 
    }
  }
})

// 批量删除文档
ipcMain.handle('knowledge:removeDocuments', async (_event, docIds: string[]) => {
  try {
    const result = await getKnowledge().removeDocuments(docIds)
    return { success: true, ...result }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '批量删除文档失败' 
    }
  }
})

// 搜索知识库
ipcMain.handle('knowledge:search', async (_event, query: string, options?: Partial<SearchOptions>) => {
  try {
    const results = await getKnowledge().search(query, options)
    return { success: true, results }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '搜索失败',
      results: []
    }
  }
})

// 获取主机相关知识
ipcMain.handle('knowledge:getHostKnowledge', async (_event, hostId: string) => {
  try {
    const results = await getKnowledge().getHostKnowledge(hostId)
    return { success: true, results }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '获取知识失败',
      results: []
    }
  }
})

// 构建 AI 上下文
ipcMain.handle('knowledge:buildContext', async (_event, query: string, options?: { hostId?: string; maxTokens?: number }) => {
  try {
    const context = await getKnowledge().buildContext(query, options)
    return { success: true, context }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '构建上下文失败',
      context: ''
    }
  }
})

// 获取所有文档
ipcMain.handle('knowledge:getDocuments', async () => {
  return getKnowledge().getDocuments()
})

// 获取指定文档
ipcMain.handle('knowledge:getDocument', async (_event, docId: string) => {
  return getKnowledge().getDocument(docId)
})

// 获取统计信息
ipcMain.handle('knowledge:getStats', async () => {
  try {
    const stats = await getKnowledge().getStats()
    return { success: true, stats }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '获取统计失败' 
    }
  }
})

// 清空知识库
ipcMain.handle('knowledge:clear', async () => {
  try {
    await getKnowledge().clear()
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '清空失败' 
    }
  }
})

// 导出知识库数据
ipcMain.handle('knowledge:exportData', async () => {
  try {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog({
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true }
    }
    
    const path = require('path')
    const exportPath = path.join(result.filePaths[0], `knowledge-backup-${Date.now()}`)
    const exportResult = await getKnowledge().exportData(exportPath)
    
    return { ...exportResult, path: exportPath }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '导出失败' 
    }
  }
})

// 导入知识库数据
ipcMain.handle('knowledge:importData', async () => {
  try {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog({
      title: '选择知识库备份目录',
      properties: ['openDirectory']
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true }
    }
    
    return await getKnowledge().importData(result.filePaths[0])
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '导入失败' 
    }
  }
})

// 检查服务状态
ipcMain.handle('knowledge:isReady', async () => {
  try {
    return getKnowledge().isReady()
  } catch {
    return false
  }
})

// 检查服务是否启用
ipcMain.handle('knowledge:isEnabled', async () => {
  try {
    return getKnowledge().isEnabled()
  } catch {
    return false
  }
})

// ==================== 模型管理相关 ====================

// 获取所有模型
ipcMain.handle('knowledge:getModels', async () => {
  return getKnowledge().getModels()
})

// 获取模型状态
ipcMain.handle('knowledge:getModelStatuses', async () => {
  return getKnowledge().getModelStatuses()
})

// 下载模型
ipcMain.handle('knowledge:downloadModel', async (event, modelId: ModelTier) => {
  try {
    await getKnowledge().downloadModel(modelId, (percent, downloaded, total) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('knowledge:downloadProgress', { modelId, percent, downloaded, total })
      }
    })
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '下载失败' 
    }
  }
})

// 切换模型
ipcMain.handle('knowledge:switchModel', async (_event, modelId: ModelTier) => {
  try {
    await getKnowledge().switchModel(modelId)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '切换模型失败' 
    }
  }
})

