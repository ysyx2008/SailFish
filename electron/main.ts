import { app, BrowserWindow, ipcMain, shell, dialog, session, Tray, Menu, nativeImage } from 'electron'
import { autoUpdater } from 'electron-updater'
import path, { join } from 'path'
import * as fs from 'fs'

// 开发模式下禁用硬件加速，避免热重载时 GPU 进程崩溃
// 这个调用必须在 app.whenReady() 之前
if (!app.isPackaged) {
  app.disableHardwareAcceleration()
}

// 注册自定义协议，让系统将 sailfish:// 链接路由到本应用
// 开发模式需要传入 Electron 可执行文件路径
if (!app.isPackaged) {
  app.setAsDefaultProtocolClient('sailfish', process.execPath, [path.resolve(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient('sailfish')
}

// 单实例锁：仅打包后启用，防止用户从 Spotlight/Launchpad 重复启动
// 开发/构建时不启用，以便 dev 与 build 可同时运行
const useSingleInstanceLock = app.isPackaged
const gotTheLock = useSingleInstanceLock ? app.requestSingleInstanceLock() : true
if (!gotTheLock) {
  app.quit()
}

// 深链 URL 队列：窗口未就绪时暂存，加载完成后依次发送
const pendingDeepLinkUrls: string[] = []

// macOS: open-url 可能在 app.ready 之前触发，需尽早注册
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (mainWindow && !mainWindow.isDestroyed()) {
    handleDeepLink(url)
  } else {
    pendingDeepLinkUrls.push(url)
  }
})

const MAX_DEEP_LINK_TASK_LENGTH = 5000

/**
 * 解析 sailfish:// 深链 URL
 * 格式：sailfish://run?task=xxx
 */
function parseDeepLinkUrl(url: string): { action: string; task?: string; skillId?: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'sailfish:') return null
    const action = parsed.hostname || parsed.pathname.replace(/^\/+/, '')
    if (action === 'run') {
      const task = parsed.searchParams.get('task')
      if (task && task.length <= MAX_DEEP_LINK_TASK_LENGTH) {
        return { action: 'run', task }
      }
    }
    if (action === 'install-skill') {
      const skillId = parsed.searchParams.get('id')
      if (skillId && skillId.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(skillId)) {
        return { action: 'install-skill', skillId }
      }
    }
    return { action }
  } catch (e) {
    console.warn('[DeepLink] Failed to parse URL:', url, e)
    return null
  }
}

/**
 * 处理深链 URL：解析后发送给渲染进程执行
 */
function handleDeepLink(url: string) {
  console.log('[DeepLink] Handling URL:', url.substring(0, 100))
  const parsed = parseDeepLinkUrl(url)
  if (!parsed) return

  const windowReady = mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isLoading()

  if (parsed.action === 'run' && parsed.task) {
    if (windowReady) {
      showMainWindow()
      mainWindow!.webContents.send('app:run-task', parsed.task)
    } else {
      pendingDeepLinkUrls.push(url)
    }
  } else if (parsed.action === 'install-skill' && parsed.skillId) {
    if (windowReady) {
      showMainWindow()
      mainWindow!.webContents.send('app:install-skill', parsed.skillId)
    } else {
      pendingDeepLinkUrls.push(url)
    }
  }
}

// 读取 package.json 获取版本号（开发模式下 app.getVersion() 返回 Electron 版本）
const packageJson = JSON.parse(fs.readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const APP_VERSION = packageJson.version

// 应用名称（多语言支持）
const APP_NAME = { zh: '旗鱼', en: 'SailFish' }

// Steam 构建标识：主进程直接读环境变量，dev/build 均可靠
const IS_STEAM_BUILD = process.env.VITE_STEAM_BUILD === 'true'
const APP_NAME_STEAM = { zh: '旗鱼终端', en: 'SFTerm' }

/**
 * 根据语言获取应用标题（Steam 版使用不同品牌名）
 */
function getAppTitle(language?: string): string {
  const lang = language || configService?.getLanguage() || 'zh-CN'
  const names = IS_STEAM_BUILD ? APP_NAME_STEAM : APP_NAME
  const name = lang.startsWith('zh') ? names.zh : names.en
  return `${name} v${APP_VERSION}`
}

/**
 * 修复 macOS/Linux GUI 应用的 PATH 环境变量问题
 * 当应用作为 GUI 应用启动时（双击 .app 或从 Dock/Spotlight 启动），
 * 不会加载用户的 shell 配置文件，导致 PATH 缺少开发工具路径
 * 
 * 优化策略：
 * 1. 立即添加常见路径（不阻塞启动）
 * 2. 异步获取完整 PATH（后台执行）
 * 3. 创建终端时等待 PATH 就绪
 */

// PATH 加载状态
let pathReady = false
let pathReadyResolve: (() => void) | null = null
const pathReadyPromise = new Promise<void>(resolve => {
  pathReadyResolve = resolve
})

/**
 * 立即添加常见的开发工具路径（同步，不阻塞）
 */
function addCommonPaths(): void {
  if (process.platform === 'win32') {
    pathReady = true
    pathReadyResolve?.()
    return
  }

  const homeDir = process.env.HOME || ''
  const commonPaths = [
    '/opt/homebrew/bin',                       // Homebrew (Apple Silicon)
    '/opt/homebrew/sbin',
    '/usr/local/bin',                          // Homebrew (Intel)
    '/usr/local/sbin',
    `${homeDir}/.local/bin`,                   // pipx, poetry 等
    `${homeDir}/.volta/bin`,                   // Volta
    `${homeDir}/.cargo/bin`,                   // Rust/Cargo
    '/usr/local/go/bin',                       // Go
    `${homeDir}/go/bin`,                       // Go workspace
  ]
  
  // 快速添加存在的路径（同步检查，但很快）
  const existingPaths = commonPaths.filter(p => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  })
  
  if (existingPaths.length > 0) {
    const currentPaths = (process.env.PATH || '').split(':')
    const allPaths = Array.from(new Set([...existingPaths, ...currentPaths]))
    process.env.PATH = allPaths.join(':')
  }
}

/**
 * 异步获取用户 shell 的完整 PATH
 */
async function fixPathAsync(): Promise<void> {
  if (process.platform === 'win32') {
    pathReady = true
    pathReadyResolve?.()
    return
  }

  try {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)
    
    const userShell = process.env.SHELL || '/bin/zsh'
    
    // 异步获取完整 PATH（使用 -l 而非 -l -i，更快）
    const { stdout } = await execAsync(`${userShell} -l -c 'echo -n $PATH'`, {
      timeout: 3000,  // 减少超时时间
      env: { ...process.env, HOME: process.env.HOME }
    })
    
    const shellPath = stdout.trim()
    if (shellPath && shellPath !== process.env.PATH) {
      const currentPaths = (process.env.PATH || '').split(':')
      const shellPaths = shellPath.split(':')
      const allPaths = Array.from(new Set([...shellPaths, ...currentPaths]))
      process.env.PATH = allPaths.join(':')
    }
  } catch (error) {
    // 异步获取失败不影响，因为已经有常见路径了
    console.warn('[fixPath] 异步获取 PATH 失败，使用预设路径:', error)
    
    // 尝试展开 nvm 路径（可能之前没添加）
    try {
      const homeDir = process.env.HOME || ''
      const nvmBase = `${homeDir}/.nvm/versions/node`
      if (fs.existsSync(nvmBase)) {
        const versions = fs.readdirSync(nvmBase)
        const nvmPaths = versions
          .map(v => `${nvmBase}/${v}/bin`)
          .filter(p => fs.existsSync(p))
        
        if (nvmPaths.length > 0) {
          const currentPaths = (process.env.PATH || '').split(':')
          const allPaths = Array.from(new Set([...nvmPaths, ...currentPaths]))
          process.env.PATH = allPaths.join(':')
        }
      }
    } catch {
      // 忽略
    }
  } finally {
    pathReady = true
    pathReadyResolve?.()
    // 通知前端 PATH 已就绪
    mainWindow?.webContents.send('path:ready')
  }
}

/**
 * 等待 PATH 就绪
 */
async function waitForPath(): Promise<void> {
  if (pathReady) return
  await pathReadyPromise
}

/**
 * 检查 PATH 是否就绪
 */
function isPathReady(): boolean {
  return pathReady
}

// 立即添加常见路径（不阻塞）
addCommonPaths()

// 异步获取完整 PATH（后台执行）
fixPathAsync()
import { PtyService } from './services/pty.service'
import { SshService } from './services/ssh.service'
import { AiService } from './services/ai.service'
import { ConfigService, McpServerConfig, setConfigServiceInstance } from './services/config.service'
import { setLogLevel as setBackendLogLevel } from './utils/logger'
import { XshellImportService } from './services/xshell-import.service'
import { AgentService, AgentStep, AgentContext } from './services/agent'
import type { PendingConfirmation } from './services/agent/types'
import { orchestratorService } from './services/agent/orchestrator'
import type { OrchestratorConfig } from './services/agent/orchestrator-types'
import { HistoryService, AgentRecord } from './services/history.service'
import { HostProfileService, HostProfile } from './services/host-profile.service'
import { getDocumentParserService, UploadedFile, ParseOptions, ParsedDocument } from './services/document-parser.service'
import { SftpService, SftpConfig } from './services/sftp.service'
import { LocalFsService } from './services/local-fs.service'
import { McpService } from './services/mcp.service'
import { getUserSkillService, UserSkill } from './services/user-skill.service'
import { getSkillMarketService, type MarketSkillItem, type SkillOperationResult, type SkillRegistry } from './services/skill-market.service'
import { getKnowledgeService, KnowledgeService } from './services/knowledge'
import type { KnowledgeSettings, SearchOptions, AddDocumentOptions, ModelTier } from './services/knowledge/types'
import {
  decrypt
} from './services/knowledge/crypto'
import { initTerminalStateService, type TerminalState, type CwdChangeEvent, type CommandExecution, type CommandExecutionEvent } from './services/terminal-state.service'
import { initTerminalAwarenessService, type TerminalAwareness } from './services/terminal-awareness'
import { initScreenContentService } from './services/screen-content.service'
import { menuService } from './services/menu.service'
import { aiDebugService } from './services/ai-debug.service'
import { getSchedulerService, type CreateTaskParams } from './services/scheduler.service'
import { getWatchService } from './services/watch/watch.service'
import { getSensorService } from './services/sensor'
import type { CreateWatchParams } from './services/watch/types'
import { getRemoteChatService } from './services/remote-chat.service'
import { getGatewayService, type GatewayConfig } from './services/gateway.service'
import { getIMService } from './services/im/im.service'
import type { DingTalkConfig, FeishuConfig, SlackConfig, TelegramConfig, WeComConfig } from './services/im/types'

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
let tray: Tray | null = null
let fileManagerWindow: BrowserWindow | null = null  // 文件管理器独立窗口
let fileManagerParams: {  // 文件管理器窗口初始化参数
  sessionId?: string
  sftpConfig?: SftpConfig
  initialLocalPath?: string
  initialRemotePath?: string
} | null = null
let forceQuit = false  // 是否强制退出（跳过确认）
let isQuitting = false  // 是否正在退出应用（Cmd+Q 触发，区分于 Cmd+W 关闭窗口）

// 服务实例
const ptyService = new PtyService()
const sshService = new SshService()
const aiService = new AiService()
const configService = new ConfigService()
setConfigServiceInstance(configService)
setBackendLogLevel(configService.getLogLevel())
const xshellImportService = new XshellImportService()
const hostProfileService = new HostProfileService()
const mcpService = new McpService()
const agentService = new AgentService(aiService, ptyService, hostProfileService, mcpService, configService, sshService)
const historyService = new HistoryService()
agentService.setHistoryService(historyService)
const documentParserService = getDocumentParserService()
const sftpService = new SftpService()
const localFsService = new LocalFsService()

// 设置 SFTP 服务到 Agent（用于 SSH 终端的文件写入）
agentService.setSftpService(sftpService)

// 定时任务调度服务
const schedulerService = getSchedulerService()

// Watch & Sensor 服务（感知层）
const sensorService = getSensorService()
const watchService = getWatchService()

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

// 知识库加载状态
let knowledgeReady = false
let knowledgeReadyResolve: (() => void) | null = null
const knowledgeReadyPromise = new Promise<void>(resolve => {
  knowledgeReadyResolve = resolve
})

function getKnowledge(): KnowledgeService {
  if (!knowledgeService) {
    knowledgeService = getKnowledgeService(configService, aiService, mcpService)
    if (!knowledgeService) {
      throw new Error('Failed to initialize KnowledgeService')
    }
  }
  return knowledgeService
}

/**
 * 等待知识库就绪
 */
async function waitForKnowledge(): Promise<void> {
  if (knowledgeReady) return
  await knowledgeReadyPromise
}

/**
 * 检查知识库是否就绪
 */
function isKnowledgeReady(): boolean {
  return knowledgeReady
}

// 在应用启动时初始化知识库服务（确保 Agent 可以访问）
async function initKnowledgeService(): Promise<void> {
  try {
    knowledgeService = getKnowledgeService(configService, aiService, mcpService)
    
    // 如果知识库已启用，初始化服务（加载向量数据）
    if (knowledgeService && knowledgeService.isEnabled()) {
      // 监听模型升级事件（维度变化导致索引重建）
      knowledgeService.once('indexCleared', ({ reason, oldDimensions, newDimensions }) => {
        console.log(`[Main] 知识库模型升级: ${reason} (${oldDimensions} -> ${newDimensions})`)
        // 通知前端正在升级
        mainWindow?.webContents.send('knowledge:upgrading', { 
          reason: 'model_upgrade',
          message: '正在升级知识库模型，请稍候...'
        })
      })
      
      // 监听重建进度（仅在升级时通知前端）
      knowledgeService.on('rebuildProgress', (progress: { current: number; total: number; filename: string }) => {
        mainWindow?.webContents.send('knowledge:rebuildProgress', progress)
      })
      
      await knowledgeService.initialize()
      
      // 迁移旧的主机 notes 到知识库
      await migrateHostNotesToKnowledge()
      
      // 预热 embedding 推理（后台执行，不阻塞）
      // ONNX 模型第一次推理需要 JIT 编译，会比较慢
      // 提前预热可以加速首次 Agent 对话响应
      knowledgeService.search('预热', { limit: 1 }).catch(() => {
        // 忽略预热错误（可能知识库为空）
      })
      console.log('[Main] Embedding 预热推理已启动')
    }
  } catch (e) {
    console.error('[Main] Failed to initialize KnowledgeService:', e)
  } finally {
    // 无论成功与否，都标记为就绪（避免无限等待）
    knowledgeReady = true
    knowledgeReadyResolve?.()
    // 通知前端知识库已就绪
    mainWindow?.webContents.send('knowledge:ready')
    console.log('[Main] 知识库服务初始化完成')
  }
}

// 迁移旧的主机 notes 到知识库
async function migrateHostNotesToKnowledge(): Promise<void> {
  if (!knowledgeService) return
  
  const fs = await import('fs')
  const path = await import('path')
  
  // 检查是否已迁移（使用标记文件）
  const userDataPath = app.getPath('userData')
  const migrationFlagPath = path.join(userDataPath, 'host-notes-migrated.flag')
  
  if (fs.existsSync(migrationFlagPath)) {
    return  // 已迁移过，跳过
  }
  
  try {
    const profiles = hostProfileService.getAllProfiles()
    for (const profile of profiles) {
      if (profile.notes && profile.notes.length > 0) {
        const migrated = await knowledgeService.migrateNotesToKnowledge(
          profile.hostId, 
          profile.notes
        )
        
        // 迁移完成后清空旧的 notes（但保留其他档案信息）
        if (migrated > 0) {
          hostProfileService.updateProfile(profile.hostId, { notes: [] })
        }
      }
    }
    
    // 创建迁移标记文件
    fs.writeFileSync(migrationFlagPath, new Date().toISOString(), 'utf-8')
  } catch (e) {
    console.error('[Main] 迁移主机 notes 失败:', e)
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

// ==================== 系统托盘 ====================

function createTray() {
  if (tray) return

  // dev 模式从项目 resources/ 读取，打包后从 app Resources/ 读取
  const resDir = app.isPackaged ? process.resourcesPath : join(__dirname, '../resources')
  const trayIconPath = process.platform === 'darwin'
    ? join(resDir, 'icon_trayTemplate.png')
    : join(resDir, 'icon.png')

  const icon = nativeImage.createFromPath(trayIconPath)
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  }

  tray = new Tray(icon)
  tray.setToolTip('SailFish')
  updateTrayMenu()

  tray.on('click', () => {
    showMainWindow()
  })
}

function updateTrayMenu() {
  if (!tray) return
  const lang = configService?.getLanguage() || 'zh-CN'
  const isZh = lang.startsWith('zh')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isZh ? '显示窗口' : 'Show Window',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: isZh ? '退出' : 'Quit',
      click: () => app.quit()
    }
  ])
  tray.setContextMenu(contextMenu)
}

function showMainWindow() {
  if (process.platform === 'darwin') {
    app.dock?.show()
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
    setupWindowServices()
  }
}

/**
 * 设置/更新各服务对 mainWindow 的引用和 did-finish-load 事件
 * 在首次创建窗口和窗口重建时调用
 */
function setupWindowServices() {
  if (!mainWindow) return

  remoteChatService.setMainWindow(mainWindow)
  gatewayService.setMainWindow(mainWindow)
  imService.setMainWindow(mainWindow)
  menuService.setMainWindow(mainWindow)

  const lang = configService?.getLanguage() || 'zh-CN'
  menuService.setLanguage(lang)
  menuService.applyMenu()
}

/**
 * 退出时清理所有后端服务和连接
 */
function cleanupAllServices() {
  watchService.stop()
  sensorService.stop().catch(() => {})
  schedulerService.stop()
  gatewayService.stop().catch(() => {})
  imService.stopAll().catch(() => {})
  remoteChatService.dispose().catch(() => {})
  ptyService.disposeAll()
  sshService.disposeAll()
  sftpService.disconnectAll()
  mcpService.disconnectAll()
}

// ==================== 主窗口 ====================

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
    title: getAppTitle(),
    icon: iconPath,
    frame: true,
    show: false, // 先不显示，等待 ready-to-show
    backgroundColor: '#1e1e1e', // 设置背景色，避免白屏闪烁
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 窗口准备好后立即显示（比 did-finish-load 更早）
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
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
    // macOS 上 window-all-closed 不会调用 app.quit()，需在确认退出并关闭主窗口后主动退出（先 quit 再置空，避免 quit 流程中读到窗口）
    if (process.platform === 'darwin' && isQuitting) {
      app.quit()
    }
    mainWindow = null
  })

  mainWindow.on('close', async (event) => {
    if (forceQuit) {
      return
    }

    if (isQuitting) {
      // Cmd+Q 退出：走终端确认逻辑
      event.preventDefault()
      try {
        mainWindow?.webContents.send('window:requestTerminalCount')
      } catch (e) {
        forceQuit = true
        mainWindow?.close()
      }
      return
    }

    // Cmd+W 关闭窗口：隐藏到托盘，服务继续运行
    event.preventDefault()
    mainWindow?.hide()
    if (process.platform === 'darwin') {
      app.dock?.hide()
    }
  })
}

/**
 * 创建文件管理器独立窗口
 */
function createFileManagerWindow(params?: {
  sessionId?: string
  sftpConfig?: SftpConfig
  initialLocalPath?: string
  initialRemotePath?: string
}): void {
  // 如果窗口已存在，聚焦并更新参数
  if (fileManagerWindow && !fileManagerWindow.isDestroyed()) {
    fileManagerWindow.focus()
    if (params) {
      fileManagerParams = params
      fileManagerWindow.webContents.send('fileManager:paramsUpdate', params)
    }
    return
  }

  // 保存初始化参数
  fileManagerParams = params || null

  // 根据平台选择图标
  const iconPath = process.platform === 'darwin'
    ? join(__dirname, '../resources/icon.icns')
    : process.platform === 'win32'
      ? join(__dirname, '../resources/icon.ico')
      : join(__dirname, '../resources/icon.png')

  fileManagerWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 900,
    minHeight: 500,
    title: '文件管理器',
    icon: iconPath,
    frame: true,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 窗口准备好后显示
  fileManagerWindow.once('ready-to-show', () => {
    fileManagerWindow?.show()
  })

  // 加载文件管理器页面
  if (process.env.VITE_DEV_SERVER_URL) {
    fileManagerWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}file-manager.html`)
    // 开发环境可以打开开发者工具
    // fileManagerWindow.webContents.openDevTools()
  } else {
    fileManagerWindow.loadFile(join(__dirname, '../dist/file-manager.html'))
  }

  // 在浏览器中打开外部链接
  fileManagerWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  fileManagerWindow.on('closed', () => {
    fileManagerWindow = null
    fileManagerParams = null
  })
}

// AI Debug 窗口
let aiDebugWindow: BrowserWindow | null = null

/**
 * 创建 AI Debug 窗口
 * 用于显示 AI 请求和响应的实时流水
 */
function createAiDebugWindow(): void {
  // 如果窗口已存在，聚焦
  if (aiDebugWindow && !aiDebugWindow.isDestroyed()) {
    aiDebugWindow.focus()
    return
  }

  // 根据平台选择图标
  const iconPath = process.platform === 'darwin'
    ? join(__dirname, '../resources/icon.icns')
    : process.platform === 'win32'
      ? join(__dirname, '../resources/icon.ico')
      : join(__dirname, '../resources/icon.png')

  aiDebugWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: 'AI Debug Console',
    icon: iconPath,
    frame: true,
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 窗口准备好后显示
  aiDebugWindow.once('ready-to-show', () => {
    aiDebugWindow?.show()
  })

  // 加载 AI Debug 页面
  if (process.env.VITE_DEV_SERVER_URL) {
    aiDebugWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}ai-debug.html`)
    // 开发环境可以打开开发者工具
    // aiDebugWindow.webContents.openDevTools()
  } else {
    aiDebugWindow.loadFile(join(__dirname, '../dist/ai-debug.html'))
  }

  // 设置到 aiDebugService
  aiDebugService.setDebugWindow(aiDebugWindow)

  // 在浏览器中打开外部链接
  aiDebugWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  aiDebugWindow.on('closed', () => {
    aiDebugWindow = null
    aiDebugService.setDebugWindow(null)
  })
}

// 应用准备就绪
app.whenReady().then(async () => {
  // 设置媒体设备权限处理器（用于语音识别等功能）
  // Windows 上必须显式授权麦克风访问，否则会报 "Requested device not found"
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // 允许麦克风、音频和剪贴板相关权限
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'clipboard-read', 'clipboard-write']
    if (allowedPermissions.includes(permission)) {
      callback(true)
    } else {
      callback(false)
    }
  })

  // 设置设备权限检查（用于 navigator.mediaDevices.enumerateDevices 等）
  session.defaultSession.setDevicePermissionHandler((details) => {
    // 允许音频输入设备访问
    if (details.deviceType === 'hid' || details.deviceType === 'serial') {
      return false
    }
    return true
  })

  // 初始化屏幕内容服务（轻量，可以同步初始化）
  initScreenContentService()

  // 先创建窗口，让用户尽快看到界面
  createWindow()
  setupWindowServices()
  createTray()

  // 窗口内容加载完成后，异步初始化重量级服务
  mainWindow?.webContents.on('did-finish-load', () => {
    // 稍微延迟初始化，确保前端 Vue 组件已挂载并注册好事件监听器
    setTimeout(() => {
      initKnowledgeService().catch(e => {
        console.error('[Main] 知识库服务初始化失败:', e)
      })
    }, 500)

    // 初始化定时任务调度服务
    try {
      schedulerService.init({
        ptyService,
        sshService,
        configService,
        agentService,
        mainWindow
      })
      schedulerService.start().catch(e => {
        console.error('[Main] 定时任务调度服务启动失败:', e)
      })
    } catch (e) {
      console.error('[Main] 定时任务调度服务初始化失败:', e)
    }

    // 初始化 Watch & Sensor 服务（感知层）
    try {
      watchService.init({
        ptyService,
        sshService,
        configService,
        agentService,
        aiService,
        sensorService,
        mainWindow
      })
      watchService.start().catch(e => {
        console.error('[Main] Watch 服务启动失败:', e)
      })

      // 从旧版定时任务迁移数据到关切系统
      try {
        const migration = watchService.migrateFromScheduler()
        if (migration.migrated > 0) {
          console.log(`[Main] 定时任务迁移完成: ${migration.migrated} 个迁移, ${migration.skipped} 个跳过`)
        }
        if (migration.errors.length > 0) {
          console.warn('[Main] 迁移警告:', migration.errors)
        }
      } catch (e) {
        console.error('[Main] 定时任务迁移失败:', e)
      }

      const awakened = configService.get('agentAwakened') as boolean ?? false
      const heartbeatInterval = configService.get('watchHeartbeatInterval') as number ?? 30

      // 启动传感器前，先把已保存的邮箱/日历账户注入传感器，否则 shouldAutoStart() 会因为 accounts 为空而跳过
      try {
        const emailAccounts = (configService.get('emailAccounts' as any) || []) as Array<{
          id: string; email: string; provider: string; imapHost?: string; imapPort?: number; rejectUnauthorized?: boolean
        }>
        if (emailAccounts.length > 0) {
          const { getServerConfig } = await import('./services/agent/skills/email/session')
          const { getEmailCredential } = await import('./services/credential.service')
          const sensorAccounts = emailAccounts.map(a => {
            const server = getServerConfig(a.provider, { imapHost: a.imapHost, imapPort: a.imapPort })
            return { accountId: a.id, email: a.email, provider: a.provider, imapHost: server.imapHost, imapPort: server.imapPort, rejectUnauthorized: a.rejectUnauthorized }
          }).filter(a => a.imapHost)
          await sensorService.email.configureAccounts(sensorAccounts, (id) => getEmailCredential(id))
          console.log(`[Main] Email sensor: loaded ${sensorAccounts.length} account(s) from config`)
        }
      } catch (e) {
        console.error('[Main] Email sensor 账户加载失败:', e)
      }

      try {
        const calendarAccounts = (configService.get('calendarAccounts' as any) || []) as Array<{
          id: string; name: string; provider: string; username: string; serverUrl?: string
        }>
        if (calendarAccounts.length > 0) {
          const { getCalendarCredential } = await import('./services/credential.service')
          const sensorAccounts = calendarAccounts.map(a => ({
            accountId: a.id, name: a.name, provider: a.provider, username: a.username, serverUrl: a.serverUrl
          }))
          await sensorService.calendar.configureAccounts(sensorAccounts, (id) => getCalendarCredential(id))
          console.log(`[Main] Calendar sensor: loaded ${sensorAccounts.length} account(s) from config`)
        }
      } catch (e) {
        console.error('[Main] Calendar sensor 账户加载失败:', e)
      }

      sensorService.start({
        heartbeatEnabled: awakened,
        heartbeatIntervalMinutes: heartbeatInterval
      }).catch(e => {
        console.error('[Main] Sensor 服务启动失败:', e)
      })

      // 觉醒模式：确保内置「日常检查」关切存在
      if (awakened) {
        try { watchService.ensureDailyPatrol() } catch (e) {
          console.error('[Main] 日常检查关切创建失败:', e)
        }
      }
    } catch (e) {
      console.error('[Main] Watch/Sensor 服务初始化失败:', e)
    }

    // Gateway 远程访问自动启动
    if (configService.get('gatewayAutoStart')) {
      const port = configService.get('gatewayPort') || 3721
      const host = configService.get('gatewayHost') || '0.0.0.0'
      gatewayService.start({ enabled: true, port, host, apiToken: '' }).then(result => {
        if (result.success) {
          console.log(`[Gateway] Auto-started on ${host}:${port}`)
        } else {
          console.error('[Gateway] Auto-start failed:', result.error)
        }
      }).catch(e => {
        console.error('[Gateway] Auto-start error:', e)
      })
    }

    // IM 集成自动连接（每平台独立控制）
    if (configService.get('imDingTalkAutoConnect')) {
      const dtClientId = configService.get('imDingTalkClientId') as string
      const dtClientSecret = configService.get('imDingTalkClientSecret') as string
      if (dtClientId && dtClientSecret) {
        imService.startDingTalk({ enabled: true, clientId: dtClientId, clientSecret: dtClientSecret }).then(result => {
          if (result.success) {
            console.log('[IM] DingTalk auto-connect started')
          } else {
            console.error('[IM] DingTalk auto-connect failed:', result.error)
          }
        }).catch(e => console.error('[IM] DingTalk auto-connect error:', e))
      }
    }
    if (configService.get('imFeishuAutoConnect')) {
      const fsAppId = configService.get('imFeishuAppId') as string
      const fsAppSecret = configService.get('imFeishuAppSecret') as string
      if (fsAppId && fsAppSecret) {
        imService.startFeishu({ enabled: true, appId: fsAppId, appSecret: fsAppSecret }).then(result => {
          if (result.success) {
            console.log('[IM] Feishu auto-connect started')
          } else {
            console.error('[IM] Feishu auto-connect failed:', result.error)
          }
        }).catch(e => console.error('[IM] Feishu auto-connect error:', e))
      }
    }
    if (configService.get('imSlackAutoConnect')) {
      const slackBotToken = (configService.get('imSlackBotToken') as string) || ''
      const slackAppToken = (configService.get('imSlackAppToken') as string) || ''
      if (slackBotToken && slackAppToken) {
        imService.startSlack({ enabled: true, botToken: slackBotToken, appToken: slackAppToken }).then(result => {
          if (result.success) {
            console.log('[IM] Slack auto-connect started')
          } else {
            console.error('[IM] Slack auto-connect failed:', result.error)
          }
        }).catch(e => console.error('[IM] Slack auto-connect error:', e))
      }
    }
    if (configService.get('imTelegramAutoConnect')) {
      const tgBotToken = (configService.get('imTelegramBotToken') as string) || ''
      if (tgBotToken) {
        imService.startTelegram({ enabled: true, botToken: tgBotToken }).then(result => {
          if (result.success) {
            console.log('[IM] Telegram auto-connect started')
          } else {
            console.error('[IM] Telegram auto-connect failed:', result.error)
          }
        }).catch(e => console.error('[IM] Telegram auto-connect error:', e))
      }
    }
    if (configService.get('imWeComAutoConnect')) {
      const wcCorpId = (configService.get('imWeComCorpId') as string) || ''
      const wcCorpSecret = (configService.get('imWeComCorpSecret') as string) || ''
      const wcAgentId = (configService.get('imWeComAgentId') as number) || 0
      const wcToken = (configService.get('imWeComToken') as string) || ''
      const wcEncodingAESKey = (configService.get('imWeComEncodingAESKey') as string) || ''
      const wcCallbackPort = (configService.get('imWeComCallbackPort') as number) || 3722
      if (wcCorpId && wcCorpSecret && wcAgentId && wcToken && wcEncodingAESKey) {
        imService.startWeCom({ enabled: true, corpId: wcCorpId, corpSecret: wcCorpSecret, agentId: wcAgentId, token: wcToken, encodingAESKey: wcEncodingAESKey, callbackPort: wcCallbackPort }).then(result => {
          if (result.success) {
            console.log('[IM] WeCom auto-connect started')
          } else {
            console.error('[IM] WeCom auto-connect failed:', result.error)
          }
        }).catch(e => console.error('[IM] WeCom auto-connect error:', e))
      }
    }
  })

  // 处理缓存的深链 URL 队列（窗口就绪前收到的）
  mainWindow?.webContents.once('dom-ready', () => {
    if (pendingDeepLinkUrls.length > 0) {
      const urls = pendingDeepLinkUrls.splice(0)
      setTimeout(() => {
        urls.forEach(url => handleDeepLink(url))
      }, 300)
    }
  })

  app.on('activate', () => {
    showMainWindow()
  })

  // Windows/Linux: 第二个实例通过 argv 传递 URL
  app.on('second-instance', (_event, argv) => {
    showMainWindow()
    const deepLinkUrl = argv.find(arg => {
      try {
        return arg.startsWith('sailfish://') || decodeURIComponent(arg).startsWith('sailfish://')
      } catch {
        return false
      }
    })
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl)
    }
  })
})

// 处理 Cmd+Q / 托盘退出
app.on('before-quit', (event) => {
  isQuitting = true
  
  if (forceQuit) {
    return
  }
  
  // 窗口可能是隐藏状态，需要先显示再走确认流程
  if (mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault()
    if (process.platform === 'darwin') {
      app.dock?.show()
    }
    mainWindow.show()
    mainWindow.close()  // 触发窗口的 close 事件，走终端确认逻辑
  }
})

// 所有窗口关闭时的处理
// macOS 上 Cmd+W 只隐藏窗口不触发此事件；真正退出时由 before-quit 驱动
app.on('window-all-closed', () => {
  cleanupAllServices()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ==================== IPC 处理器 ====================

// PTY 相关
ipcMain.handle('pty:create', async (_event, options) => {
  // 等待 PATH 就绪后再创建终端
  await waitForPath()
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
  // 清理该终端的 Agent 实例和任务历史记忆
  agentService.cleanupAgent(id)
})

ipcMain.handle('pty:getAvailableShells', async () => {
  return ptyService.getAvailableShells()
})

// PTY 数据订阅的取消函数存储（防止重复订阅导致数据多次发送）
const ptyDataUnsubscribes = new Map<string, () => void>()

// PTY 数据输出 - 转发到渲染进程
ipcMain.on('pty:subscribe', (event, id: string) => {
  // 先取消旧的订阅，防止重复订阅导致数据多次发送
  const oldUnsubscribe = ptyDataUnsubscribes.get(id)
  if (oldUnsubscribe) {
    oldUnsubscribe()
    ptyDataUnsubscribes.delete(id)
  }

  const unsubscribe = ptyService.onData(id, (data: string) => {
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
  ptyDataUnsubscribes.set(id, unsubscribe)
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
  // 清理该终端的 Agent 实例和任务历史记忆
  agentService.cleanupAgent(id)
})

// SSH 数据订阅的取消函数存储
const sshDataUnsubscribes = new Map<string, () => void>()
// SSH 断开连接订阅的取消函数存储
const sshDisconnectUnsubscribes = new Map<string, () => void>()

ipcMain.on('ssh:subscribe', (event, id: string) => {
  // 先取消旧的订阅，防止重复订阅导致数据多次发送
  const oldDataUnsubscribe = sshDataUnsubscribes.get(id)
  if (oldDataUnsubscribe) {
    oldDataUnsubscribe()
    sshDataUnsubscribes.delete(id)
  }
  const oldDisconnectUnsubscribe = sshDisconnectUnsubscribes.get(id)
  if (oldDisconnectUnsubscribe) {
    oldDisconnectUnsubscribe()
    sshDisconnectUnsubscribes.delete(id)
  }

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
    // 清理该终端的 Agent 实例和任务历史记忆（SSH 被动断开时也需要清理）
    agentService.cleanupAgent(id)
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

// 刷新 CWD（强制刷新，用于打开文件管理器等场景）
ipcMain.handle('terminalState:refreshCwd', async (_event, id: string): Promise<string> => {
  // 使用 'command' trigger 绕过时间间隔检查，强制获取最新 CWD
  return terminalStateService.refreshCwd(id, 'command')
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
ipcMain.handle('terminalState:startExecution', async (
  _event, 
  id: string, 
  command: string,
  options?: { source?: 'user' | 'agent'; agentStepTitle?: string }
): Promise<CommandExecution | null> => {
  return terminalStateService.startCommandExecution(id, command, options)
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

ipcMain.handle('app:getMessagingDocsPath', async () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'docs', 'messaging')
  }
  return path.join(__dirname, '..', 'docs', 'messaging')
})

// 打开路径（文件或目录）
ipcMain.handle('shell:openPath', async (_event, path: string) => {
  return shell.openPath(path)
})

// PATH 环境变量状态
ipcMain.handle('path:isReady', async () => {
  return isPathReady()
})

ipcMain.handle('path:waitReady', async () => {
  await waitForPath()
  return true
})

// 关闭当前窗口
ipcMain.handle('window:close', async () => {
  mainWindow?.close()
})

// 响应终端数量查询，决定是否需要确认退出
ipcMain.on('window:terminalCountResponse', async (_event, terminalCount: number) => {
  if (terminalCount > 0) {
    // 有终端，显示确认对话框
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      buttons: ['取消', '退出'],
      defaultId: 0,
      cancelId: 0,
      title: '确认退出',
      message: '确定要退出程序吗？',
      detail: `当前有 ${terminalCount} 个终端会话正在运行，退出将关闭所有会话。`
    })

    if (result.response === 1) {
      // 用户确认退出
      forceQuit = true
      mainWindow?.close()
    } else {
      // 用户取消，重置退出标志
      isQuitting = false
    }
  } else {
    // 没有终端，直接退出
    forceQuit = true
    mainWindow?.close()
  }
})

// 强制退出（跳过确认）
ipcMain.handle('window:forceQuit', async () => {
  forceQuit = true
  mainWindow?.close()
})

// ==================== 自动更新 ====================

// 配置自动更新
autoUpdater.autoDownload = false  // 禁用自动下载，由用户手动触发
autoUpdater.autoInstallOnAppQuit = true

// 更新状态
let updateStatus: {
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
} = { status: 'idle' }

// 自动更新事件处理
autoUpdater.on('checking-for-update', () => {
  console.log('[AutoUpdater] 正在检查更新...')
  updateStatus = { status: 'checking' }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
})

autoUpdater.on('update-available', (info) => {
  console.log('[AutoUpdater] 发现新版本:', info.version)
  updateStatus = {
    status: 'available',
    info: {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate
    }
  }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
})

autoUpdater.on('update-not-available', () => {
  console.log('[AutoUpdater] 当前已是最新版本')
  updateStatus = { status: 'not-available' }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
})

autoUpdater.on('download-progress', (progress) => {
  console.log(`[AutoUpdater] 下载进度: ${progress.percent.toFixed(1)}%`)
  updateStatus = {
    status: 'downloading',
    progress: {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total,
      transferred: progress.transferred
    }
  }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
})

autoUpdater.on('update-downloaded', (info) => {
  console.log('[AutoUpdater] 更新下载完成:', info.version)
  updateStatus = {
    status: 'downloaded',
    info: {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate
    }
  }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
})

autoUpdater.on('error', (error) => {
  console.error('[AutoUpdater] 更新错误:', error)
  updateStatus = {
    status: 'error',
    error: error.message || '未知错误'
  }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
})

// 检查更新
ipcMain.handle('updater:checkForUpdates', async () => {
  try {
    // 开发模式下模拟检查更新
    if (!app.isPackaged) {
      console.log('[AutoUpdater] 开发模式，模拟检查更新')
      updateStatus = { status: 'checking' }
      mainWindow?.webContents.send('updater:status-changed', updateStatus)
      
      // 模拟延迟
      await new Promise(resolve => setTimeout(resolve, 1500))
      
      updateStatus = { status: 'not-available' }
      mainWindow?.webContents.send('updater:status-changed', updateStatus)
      return { success: true, status: updateStatus }
    }
    
    const result = await autoUpdater.checkForUpdates()
    return { success: true, updateInfo: result?.updateInfo }
  } catch (error) {
    console.error('[AutoUpdater] 检查更新失败:', error)
    return { success: false, error: error instanceof Error ? error.message : '检查更新失败' }
  }
})

// 下载更新
ipcMain.handle('updater:downloadUpdate', async () => {
  try {
    if (!app.isPackaged) {
      console.log('[AutoUpdater] 开发模式，模拟下载更新')
      return { success: false, error: '开发模式不支持下载更新' }
    }
    
    await autoUpdater.downloadUpdate()
    return { success: true }
  } catch (error) {
    console.error('[AutoUpdater] 下载更新失败:', error)
    return { success: false, error: error instanceof Error ? error.message : '下载更新失败' }
  }
})

// 安装更新并重启
ipcMain.handle('updater:quitAndInstall', async () => {
  try {
    autoUpdater.quitAndInstall(false, true)
    return { success: true }
  } catch (error) {
    console.error('[AutoUpdater] 安装更新失败:', error)
    return { success: false, error: error instanceof Error ? error.message : '安装更新失败' }
  }
})

// 获取当前更新状态
ipcMain.handle('updater:getStatus', async () => {
  return updateStatus
})

// 配置相关
ipcMain.handle('config:get', async (_event, key: string) => {
  return configService.get(key as keyof typeof configService extends { get(key: infer K): unknown } ? K : never)
})

ipcMain.handle('config:set', async (_event, key: string, value: unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configService.set(key as any, value as any)
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
  configService.setUiTheme(theme as 'dark' | 'light' | 'blue' | 'gruvbox' | 'forest' | 'ayu-mirage' | 'cyberpunk' | 'lavender' | 'aurora' | 'sponsor-gold' | 'sponsor-sakura' | 'sponsor-rose-pine')
})

// Agent MBTI 配置
ipcMain.handle('config:getAgentMbti', async () => {
  return configService.getAgentMbti()
})

ipcMain.handle('config:setAgentMbti', async (_event, mbti: string | null) => {
  configService.setAgentMbti(mbti as import('./services/config.service').AgentMbtiType)
})

// Agent 调试模式
ipcMain.handle('config:getAgentDebugMode', async () => {
  return configService.getAgentDebugMode()
})

ipcMain.handle('config:setAgentDebugMode', async (_event, enabled: boolean) => {
  configService.setAgentDebugMode(enabled)
})

// AI Debug 窗口
// 先移除可能已存在的 handlers（ai-debug.service.ts 中已注册了一些）
try { ipcMain.removeHandler('aiDebug:openWindow') } catch { /* ignore */ }
try { ipcMain.removeHandler('aiDebug:closeWindow') } catch { /* ignore */ }

ipcMain.handle('aiDebug:openWindow', async () => {
  createAiDebugWindow()
})

ipcMain.handle('aiDebug:closeWindow', async () => {
  if (aiDebugWindow && !aiDebugWindow.isDestroyed()) {
    aiDebugWindow.close()
  }
})

// 注意: aiDebug:isWindowOpen 已在 ai-debug.service.ts 中注册，这里不重复注册

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
  // 更新窗口标题以反映语言变化
  if (mainWindow) {
    mainWindow.setTitle(getAppTitle(language))
  }
  // 更新菜单栏语言
  menuService.updateMenu(language)
})

ipcMain.handle('config:getSponsorStatus', async () => {
  return configService.getSponsorStatus()
})

ipcMain.handle('config:setSponsorStatus', async (_event, status: boolean) => {
  configService.setSponsorStatus(status)
})

// 排序设置
ipcMain.handle('config:getSessionSortBy', async () => {
  return configService.getSessionSortBy()
})

ipcMain.handle('config:setSessionSortBy', async (_event, sortBy: string) => {
  configService.setSessionSortBy(sortBy as import('./services/config.service').SessionSortBy)
})

ipcMain.handle('config:getDefaultGroupSortOrder', async () => {
  return configService.getDefaultGroupSortOrder()
})

ipcMain.handle('config:setDefaultGroupSortOrder', async (_event, order: number) => {
  configService.setDefaultGroupSortOrder(order)
})

// 文件书签相关
ipcMain.handle('config:getFileBookmarks', async () => {
  return configService.getFileBookmarks()
})

ipcMain.handle('config:setFileBookmarks', async (_event, bookmarks) => {
  configService.setFileBookmarks(bookmarks)
})

ipcMain.handle('config:addFileBookmark', async (_event, bookmark) => {
  configService.addFileBookmark(bookmark)
})

ipcMain.handle('config:updateFileBookmark', async (_event, bookmark) => {
  configService.updateFileBookmark(bookmark)
})

ipcMain.handle('config:deleteFileBookmark', async (_event, id: string) => {
  configService.deleteFileBookmark(id)
})

ipcMain.handle('config:getLocalBookmarks', async () => {
  return configService.getLocalBookmarks()
})

ipcMain.handle('config:getRemoteBookmarks', async (_event, hostId?: string) => {
  return configService.getRemoteBookmarks(hostId)
})

// AI Rules 相关
ipcMain.handle('config:getAiRules', async () => {
  return configService.getAiRules()
})

ipcMain.handle('config:setAiRules', async (_event, rules: string) => {
  configService.setAiRules(rules)
})

// 日志级别
ipcMain.handle('config:getLogLevel', async () => {
  return configService.getLogLevel()
})

ipcMain.handle('config:setLogLevel', async (_event, level: string) => {
  const logLevel = level as import('./utils/logger').LogLevel
  configService.setLogLevel(logLevel)
  setBackendLogLevel(logLevel)
})

// ==================== 定时任务调度相关 ====================

ipcMain.handle('scheduler:getTasks', async () => {
  return schedulerService.getTasks()
})

ipcMain.handle('scheduler:getTask', async (_event, id: string) => {
  return schedulerService.getTask(id)
})

ipcMain.handle('scheduler:createTask', async (_event, params: CreateTaskParams) => {
  return schedulerService.createTask(params)
})

ipcMain.handle('scheduler:updateTask', async (_event, id: string, updates: Partial<CreateTaskParams>) => {
  return schedulerService.updateTask(id, updates)
})

ipcMain.handle('scheduler:deleteTask', async (_event, id: string) => {
  return schedulerService.deleteTask(id)
})

ipcMain.handle('scheduler:toggleTask', async (_event, id: string) => {
  return schedulerService.toggleTask(id)
})

ipcMain.handle('scheduler:runTask', async (_event, id: string) => {
  return schedulerService.runTask(id)
})

ipcMain.handle('scheduler:getHistory', async (_event, taskId?: string, limit?: number) => {
  return schedulerService.getHistory(taskId, limit)
})

ipcMain.handle('scheduler:clearHistory', async (_event, taskId?: string) => {
  return schedulerService.clearHistory(taskId)
})

ipcMain.handle('scheduler:getSshSessions', async () => {
  return schedulerService.getSshSessions()
})

ipcMain.handle('scheduler:isTaskRunning', async (_event, taskId: string) => {
  return schedulerService.isTaskRunning(taskId)
})

ipcMain.handle('scheduler:getRunningTasks', async () => {
  return schedulerService.getRunningTasks()
})

// ==================== Watch & Sensor IPC ====================

ipcMain.handle('watch:getAll', async () => {
  return watchService.getAll()
})

ipcMain.handle('watch:get', async (_event, id: string) => {
  return watchService.get(id)
})

ipcMain.handle('watch:create', async (_event, params: CreateWatchParams) => {
  return watchService.create(params)
})

ipcMain.handle('watch:update', async (_event, id: string, updates: Partial<CreateWatchParams>) => {
  return watchService.update(id, updates)
})

ipcMain.handle('watch:delete', async (_event, id: string) => {
  return watchService.delete(id)
})

ipcMain.handle('watch:toggle', async (_event, id: string) => {
  return watchService.toggle(id)
})

ipcMain.handle('watch:trigger', async (_event, id: string) => {
  // Fire-and-forget: 不阻塞前端等待执行完成，通过 IPC 事件推送状态
  watchService.triggerWatch(id).catch(e => {
    console.error('[Main] Watch trigger failed:', e)
  })
  return { triggered: true }
})

ipcMain.handle('watch:getHistory', async (_event, watchId?: string, limit?: number) => {
  return watchService.getHistory(watchId, limit)
})

ipcMain.handle('watch:clearHistory', async (_event, watchId?: string) => {
  return watchService.clearHistory(watchId)
})

ipcMain.handle('watch:isRunning', async (_event, id: string) => {
  return watchService.isWatchRunning(id)
})

ipcMain.handle('watch:getRunning', async () => {
  return watchService.getRunningWatches()
})

ipcMain.handle('watch:getSshSessions', async () => {
  return watchService.getSshSessions()
})

// Sensor 相关
ipcMain.handle('sensor:getStatus', async () => {
  return sensorService.getSensorStatus()
})

ipcMain.handle('sensor:getRecentEvents', async (_event, limit?: number) => {
  return sensorService.getRecentEvents(limit)
})

ipcMain.handle('sensor:setAwakened', async (_event, awakened: boolean, intervalMinutes?: number) => {
  const validInterval = (intervalMinutes && intervalMinutes > 0 && intervalMinutes <= 1440)
    ? intervalMinutes
    : undefined
  if (awakened) {
    if (validInterval) {
      sensorService.heartbeat.setInterval(validInterval)
    }
    await sensorService.heartbeat.start()
    // 如果 email/calendar sensor 已配置账户，跟随觉醒模式一起启动
    if (sensorService.email.shouldAutoStart() && !sensorService.email.running) {
      await sensorService.email.start()
    }
    if (sensorService.calendar.shouldAutoStart() && !sensorService.calendar.running) {
      await sensorService.calendar.start()
    }
    watchService.ensureDailyPatrol()
  } else {
    await sensorService.heartbeat.stop()
    await sensorService.email.stop()
    await sensorService.calendar.stop()
    watchService.removeDailyPatrol()
  }
  configService.set('agentAwakened', awakened)
  configService.set('watchHeartbeatEnabled', awakened)
  if (validInterval) {
    configService.set('watchHeartbeatInterval', validInterval)
  }
  return { awakened, intervalMinutes: sensorService.heartbeat.getIntervalMinutes() }
})

// 向后兼容：旧的 setHeartbeat IPC，内部转发到 setAwakened 逻辑
ipcMain.handle('sensor:setHeartbeat', async (_event, enabled: boolean, intervalMinutes?: number) => {
  console.warn('[DEPRECATED] sensor:setHeartbeat 已废弃，请使用 sensor:setAwakened')
  const validInterval = (intervalMinutes && intervalMinutes > 0 && intervalMinutes <= 1440)
    ? intervalMinutes
    : undefined
  if (enabled) {
    if (validInterval) {
      sensorService.heartbeat.setInterval(validInterval)
    }
    await sensorService.heartbeat.start()
    if (sensorService.email.shouldAutoStart() && !sensorService.email.running) {
      await sensorService.email.start()
    }
    if (sensorService.calendar.shouldAutoStart() && !sensorService.calendar.running) {
      await sensorService.calendar.start()
    }
    watchService.ensureDailyPatrol()
  } else {
    await sensorService.heartbeat.stop()
    await sensorService.email.stop()
    await sensorService.calendar.stop()
    watchService.removeDailyPatrol()
  }
  configService.set('agentAwakened', enabled)
  configService.set('watchHeartbeatEnabled', enabled)
  if (validInterval) {
    configService.set('watchHeartbeatInterval', validInterval)
  }
  return { enabled, intervalMinutes: sensorService.heartbeat.getIntervalMinutes() }
})

ipcMain.handle('sensor:triggerHeartbeat', async () => {
  sensorService.heartbeat.beat()
  return { success: true }
})

// Watch 模板
ipcMain.handle('watch:getTemplates', async () => {
  return watchService.getTemplates().map(t => ({
    id: t.id,
    name: t.name,
    nameEn: t.nameEn,
    description: t.description,
    descriptionEn: t.descriptionEn,
    category: t.category,
    icon: t.icon
  }))
})

ipcMain.handle('watch:getTemplateCategories', async () => {
  return watchService.getTemplateCategories()
})

ipcMain.handle('watch:createFromTemplate', async (_event, templateId: string, options?: Record<string, unknown>) => {
  return watchService.createFromTemplate(templateId, options)
})

// Watch 共享状态
ipcMain.handle('watch:getSharedState', async () => {
  return watchService.getSharedState()
})

ipcMain.handle('watch:setSharedState', async (_event, key: string, value: unknown) => {
  watchService.setSharedState(key, value)
  return { success: true }
})

ipcMain.handle('watch:clearSharedState', async () => {
  watchService.clearSharedState()
  return { success: true }
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

ipcMain.handle('xshell:importDirectories', async (_event, dirPaths: string[]) => {
  return xshellImportService.importFromDirectories(dirPaths)
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
  // 从持久化配置读取 debugMode，合并到运行时配置
  const debugMode = configService.getAgentDebugMode()
  const fullConfig = { ...config, debugMode }
  
  // 创建回调函数，将 Agent 事件转发到渲染进程
  // 使用 JSON.parse(JSON.stringify()) 确保对象可序列化
  // 在事件中携带 ptyId，前端可以用它可靠地匹配 tab
  // 注意：回调作为参数传入 run()，每个 run 独立，解决多终端并发时回调覆盖问题
  const callbacks = {
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
    onComplete: (agentId: string, result: string, pendingUserMessages?: string[]) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:complete', { agentId, ptyId, result, pendingUserMessages })
      }
    },
    onError: (agentId: string, error: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:error', { agentId, ptyId, error })
      }
    }
  }

  try {
    // 传入回调参数，确保每个 run 有独立的回调（解决多终端同时运行时步骤串台问题）
    const result = await agentService.run(ptyId, message, context, fullConfig, profileId, undefined, callbacks)
    return { success: true, result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    const isAborted = errorMsg === 'User aborted Agent execution'
    return { 
      success: false, 
      error: errorMsg,
      aborted: isAborted
    }
  }
})

// 中止 Agent（改用 ptyId）
ipcMain.handle('agent:abort', async (_event, ptyId: string) => {
  return agentService.abort(ptyId)
})

// 清空指定终端的任务历史记忆（用于"清空对话"功能）
// 只重置会话状态和记忆，保留 Agent 实例（避免销毁后重建的开销）
ipcMain.handle('agent:clearHistory', async (_event, ptyId: string) => {
  agentService.resetSession(ptyId)
})

// 确认工具调用（改用 ptyId）
ipcMain.handle('agent:confirm', async (_event, { ptyId, toolCallId, approved, modifiedArgs, alwaysAllow }: {
  ptyId: string
  toolCallId: string
  approved: boolean
  modifiedArgs?: Record<string, unknown>
  alwaysAllow?: boolean
}) => {
  return agentService.confirmToolCall(ptyId, toolCallId, approved, modifiedArgs, alwaysAllow)
})

// 获取 Agent 状态（改用 ptyId）
ipcMain.handle('agent:getStatus', async (_event, ptyId: string) => {
  return agentService.getRunStatus(ptyId)
})

// 获取 Agent 执行阶段状态（用于智能打断判断，改用 ptyId）
ipcMain.handle('agent:getExecutionPhase', async (_event, ptyId: string) => {
  return agentService.getExecutionPhase(ptyId)
})

// 清理 Agent 运行记录（改用 ptyId）
ipcMain.handle('agent:cleanup', async (_event, ptyId: string) => {
  agentService.cleanupAgent(ptyId)
})

// 更新 Agent 配置（如执行模式、超时时间，改用 ptyId）
ipcMain.handle('agent:updateConfig', async (_event, ptyId: string, config: { executionMode?: 'strict' | 'relaxed' | 'free'; commandTimeout?: number; profileId?: string }) => {
  return agentService.updateConfig(ptyId, config)
})

// 添加用户补充消息（Agent 执行过程中，改用 ptyId）
ipcMain.handle('agent:addMessage', async (_event, ptyId: string, message: string) => {
  return agentService.addUserMessage(ptyId, message)
})

// 运行独立助手 Agent（无终端绑定）
// 注意：事件中使用前端传入的 agentId（如 assistant-<uuid>），而非后端 run.id，
// 因为独立助手没有 ptyId，前端依赖 agentId 匹配事件到正确的标签页。
ipcMain.handle('agent:runStandalone', async (event, { agentId, message, context, config, profileId }: {
  agentId: string
  message: string
  context: AgentContext
  config?: object
  profileId?: string
}) => {
  const debugMode = configService.getAgentDebugMode()
  const fullConfig = { ...config, debugMode }
  
  const rcs = getRemoteChatService()
  const isRemote = agentId === rcs.getAgentId()

  const callbacks = {
    onStep: (_runId: string, step: AgentStep) => {
      if (!event.sender.isDestroyed()) {
        const serializedStep = JSON.parse(JSON.stringify(step))
        event.sender.send('agent:step', { agentId, step: serializedStep })
      }
      if (isRemote) rcs.onAgentStep(step)
    },
    onNeedConfirm: (confirmation: PendingConfirmation) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:needConfirm', {
          agentId,
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel
        })
      }
    },
    onComplete: (_runId: string, result: string, pendingUserMessages?: string[]) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:complete', { agentId, result, pendingUserMessages })
      }
      if (isRemote) rcs.onAgentComplete(result)
    },
    onError: (_runId: string, error: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:error', { agentId, error })
      }
      if (isRemote) rcs.onAgentError(error)
    }
  }

  try {
    const result = await agentService.runAssistant(agentId, message, context, fullConfig, profileId, callbacks)
    return { success: true, result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    const isAborted = errorMsg === 'User aborted Agent execution'
    if (isRemote) rcs.onAgentError(errorMsg)
    return {
      success: false,
      error: errorMsg,
      aborted: isAborted
    }
  }
})

// ==================== 远程会话共享服务 ====================

const remoteChatService = getRemoteChatService()
remoteChatService.setDependencies({
  agentService,
  configService,
  mainWindow: null  // 初始化时 mainWindow 还未创建
})

// ==================== Gateway 远程访问 ====================

const gatewayService = getGatewayService()
gatewayService.setDependencies({
  remoteChatService,
  mainWindow: null
})

ipcMain.handle('gateway:start', async (_event, config: GatewayConfig) => {
  const result = await gatewayService.start(config)
  if (result.success) {
    // 保存端口和监听地址到配置
    configService.set('gatewayPort', config.port || 3721)
    configService.set('gatewayHost', config.host || '0.0.0.0')
  }
  return result
})

ipcMain.handle('gateway:stop', async () => {
  await gatewayService.stop()
  return { success: true }
})

ipcMain.handle('gateway:getConfig', async () => {
  return gatewayService.getConfig()
})

ipcMain.handle('gateway:isRunning', async () => {
  return gatewayService.isRunning()
})

ipcMain.handle('gateway:getAutoStart', async () => {
  return configService.get('gatewayAutoStart')
})

ipcMain.handle('gateway:setAutoStart', async (_event, enabled: boolean) => {
  configService.set('gatewayAutoStart', enabled)
})

ipcMain.handle('gateway:getAuditLog', async (_event, limit?: number) => {
  return gatewayService.getAuditLog(limit)
})

// ==================== IM 集成服务 ====================

const imService = getIMService()
imService.setDependencies({
  remoteChatService,
  mainWindow: null
})
// 从持久化配置恢复 IM 执行模式
const savedImExecutionMode = configService.get('imExecutionMode') as string | undefined
if (savedImExecutionMode && ['strict', 'relaxed', 'free'].includes(savedImExecutionMode)) {
  imService.setExecutionMode(savedImExecutionMode as 'strict' | 'relaxed' | 'free')
}

ipcMain.handle('im:startDingTalk', async (_event, config: DingTalkConfig) => {
  // 保存配置
  configService.set('imDingTalkClientId', config.clientId)
  configService.set('imDingTalkClientSecret', config.clientSecret)
  return await imService.startDingTalk(config)
})

ipcMain.handle('im:stopDingTalk', async () => {
  await imService.stopDingTalk()
  return { success: true }
})

ipcMain.handle('im:startFeishu', async (_event, config: FeishuConfig) => {
  // 保存配置
  configService.set('imFeishuAppId', config.appId)
  configService.set('imFeishuAppSecret', config.appSecret)
  return await imService.startFeishu(config)
})

ipcMain.handle('im:stopFeishu', async () => {
  await imService.stopFeishu()
  return { success: true }
})

ipcMain.handle('im:startSlack', async (_event, config: SlackConfig) => {
  configService.set('imSlackBotToken', config.botToken)
  configService.set('imSlackAppToken', config.appToken)
  return await imService.startSlack(config)
})

ipcMain.handle('im:stopSlack', async () => {
  await imService.stopSlack()
  return { success: true }
})

ipcMain.handle('im:startTelegram', async (_event, config: TelegramConfig) => {
  configService.set('imTelegramBotToken', config.botToken)
  return await imService.startTelegram(config)
})

ipcMain.handle('im:stopTelegram', async () => {
  await imService.stopTelegram()
  return { success: true }
})

ipcMain.handle('im:startWeCom', async (_event, config: WeComConfig) => {
  configService.set('imWeComCorpId', config.corpId)
  configService.set('imWeComCorpSecret', config.corpSecret)
  configService.set('imWeComAgentId', config.agentId)
  configService.set('imWeComToken', config.token)
  configService.set('imWeComEncodingAESKey', config.encodingAESKey)
  configService.set('imWeComCallbackPort', config.callbackPort)
  return await imService.startWeCom(config)
})

ipcMain.handle('im:stopWeCom', async () => {
  await imService.stopWeCom()
  return { success: true }
})

ipcMain.handle('im:getStatus', async () => {
  return imService.getStatus()
})

ipcMain.handle('im:getConfig', async () => {
  return {
    dingtalk: {
      clientId: (configService.get('imDingTalkClientId') as string) || '',
      clientSecret: (configService.get('imDingTalkClientSecret') as string) || '',
      autoConnect: configService.get('imDingTalkAutoConnect') || false,
    },
    feishu: {
      appId: (configService.get('imFeishuAppId') as string) || '',
      appSecret: (configService.get('imFeishuAppSecret') as string) || '',
      autoConnect: configService.get('imFeishuAutoConnect') || false,
    },
    slack: {
      botToken: (configService.get('imSlackBotToken') as string) || '',
      appToken: (configService.get('imSlackAppToken') as string) || '',
      autoConnect: configService.get('imSlackAutoConnect') || false,
    },
    telegram: {
      botToken: (configService.get('imTelegramBotToken') as string) || '',
      autoConnect: configService.get('imTelegramAutoConnect') || false,
    },
    wecom: {
      corpId: (configService.get('imWeComCorpId') as string) || '',
      corpSecret: (configService.get('imWeComCorpSecret') as string) || '',
      agentId: (configService.get('imWeComAgentId') as number) || 0,
      token: (configService.get('imWeComToken') as string) || '',
      encodingAESKey: (configService.get('imWeComEncodingAESKey') as string) || '',
      callbackPort: (configService.get('imWeComCallbackPort') as number) || 3722,
      autoConnect: configService.get('imWeComAutoConnect') || false,
    },
    executionMode: (configService.get('imExecutionMode') as string) || 'relaxed',
  }
})

ipcMain.handle('im:setAutoConnect', async (_event, platform: string, enabled: boolean) => {
  if (platform === 'dingtalk') {
    configService.set('imDingTalkAutoConnect', enabled)
  } else if (platform === 'feishu') {
    configService.set('imFeishuAutoConnect', enabled)
  } else if (platform === 'slack') {
    configService.set('imSlackAutoConnect', enabled)
  } else if (platform === 'telegram') {
    configService.set('imTelegramAutoConnect', enabled)
  } else if (platform === 'wecom') {
    configService.set('imWeComAutoConnect', enabled)
  }
})

ipcMain.handle('im:setExecutionMode', async (_event, mode: 'strict' | 'relaxed' | 'free') => {
  configService.set('imExecutionMode', mode)
  imService.setExecutionMode(mode)
})

// 更新远程 Agent 运行时执行模式（仅运行时，不持久化，用于 tab 界面手动切换）
ipcMain.handle('remote-chat:setExecutionMode', async (_event, mode: 'strict' | 'relaxed' | 'free') => {
  if (!['strict', 'relaxed', 'free'].includes(mode)) return
  remoteChatService.executionMode = mode
})

ipcMain.handle('im:sendNotification', async (_event, text: string, options?: { markdown?: boolean; title?: string }) => {
  return await imService.sendNotification(text, options)
})

// ==================== 智能巡检协调器相关 ====================

// 初始化协调器服务依赖
// 记录终端类型（用于 Worker Agent 获取正确的上下文）
const terminalTypes = new Map<string, 'local' | 'ssh'>()

function initOrchestratorService() {
  orchestratorService.setServices({
    aiService,
    getSshSessions: () => configService.getSshSessions(),
    createLocalTerminal: async () => {
      // 创建本地终端
      const tabId = ptyService.create({})
      terminalTypes.set(tabId, 'local')
      terminalStateService.initTerminal(tabId, 'local')
      return tabId
    },
    createSshTerminal: async (sshConfig) => {
      // 创建 SSH 终端
      const config = sshConfig as {
        host: string
        port: number
        username: string
        password?: string
        privateKey?: string
      }
      const tabId = await sshService.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey
      })
      terminalTypes.set(tabId, 'ssh')
      terminalStateService.initTerminal(tabId, 'ssh')
      return tabId
    },
    closeTerminal: async (terminalId) => {
      const type = terminalTypes.get(terminalId)
      if (type === 'local') {
        ptyService.dispose(terminalId)
      } else {
        sshService.disconnect(terminalId)
      }
      terminalTypes.delete(terminalId)
      terminalStateService.removeTerminal(terminalId)
      // 清理该终端的 Agent 实例和任务历史记忆
      agentService.cleanupAgent(terminalId)
    },
    getTerminalType: (terminalId) => {
      return terminalTypes.get(terminalId) || 'ssh'
    },
    runWorkerAgent: async (ptyId, task, workerOptions) => {
      const type = terminalTypes.get(ptyId) || 'ssh'
      
      // Worker Agent 的上下文：初始输出为空，Agent 运行时会通过工具获取最新输出
      const context: AgentContext = {
        ptyId,
        terminalOutput: [],  // Worker 启动时输出为空，实际输出会在运行时获取
        systemInfo: { 
          os: type === 'local' ? process.platform : 'linux', 
          shell: type === 'local' ? (process.env.SHELL || 'bash') : 'bash' 
        },
        terminalType: type
      }
      // 运行 Worker Agent（使用严格模式）
      return agentService.run(ptyId, task, context, { executionMode: 'strict' }, undefined, workerOptions)
    }
  })
}

// 启动智能巡检任务
ipcMain.handle('orchestrator:start', async (_event, task: string, config?: Partial<OrchestratorConfig>) => {
  // 确保协调器服务已初始化
  initOrchestratorService()
  return orchestratorService.startTask(task, config)
})

// 停止智能巡检任务
ipcMain.handle('orchestrator:stop', async (_event, orchestratorId: string) => {
  return orchestratorService.stopTask(orchestratorId)
})

// 获取可用主机列表（直接从 configService 获取，不依赖协调器初始化）
ipcMain.handle('orchestrator:listHosts', async () => {
  const sessions = configService.getSshSessions()
  return sessions.map(session => ({
    hostId: session.id,
    name: session.name,
    host: session.host,
    port: session.port,
    username: session.username,
    group: session.group,
    groupId: session.groupId
  }))
})

// 响应批量确认
ipcMain.handle('orchestrator:batchConfirmResponse', async (
  _event,
  orchestratorId: string,
  action: 'cancel' | 'current' | 'all',
  selectedTerminals?: string[]
) => {
  orchestratorService.respondBatchConfirm(orchestratorId, action, selectedTerminals)
})

// 获取协调器状态
ipcMain.handle('orchestrator:getStatus', async (_event, orchestratorId: string) => {
  const status = orchestratorService.getStatus(orchestratorId)
  if (!status) return null
  // 序列化 Map 为数组
  return {
    ...status,
    workers: Array.from(status.workers.values())
  }
})

// ==================== 历史记录相关 ====================

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
            mergedSessions.push(session as unknown as typeof existingSessions[0])
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
            mergedProfiles.push(profile as unknown as typeof existingProfiles[0])
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

// ==================== 本地文件系统相关 ====================

// 获取主目录
ipcMain.handle('localFs:getHomeDir', async () => {
  return localFsService.getHomeDir()
})

// 获取驱动器列表
ipcMain.handle('localFs:getDrives', async () => {
  return localFsService.getDrives()
})

// 列出目录内容
ipcMain.handle('localFs:list', async (_event, dirPath: string) => {
  try {
    const files = await localFsService.list(dirPath)
    return { success: true, data: files }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '列出目录失败' 
    }
  }
})

// 获取文件信息
ipcMain.handle('localFs:stat', async (_event, filePath: string) => {
  try {
    const stat = await localFsService.stat(filePath)
    return { success: true, data: stat }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '获取文件信息失败' 
    }
  }
})

// 检查路径是否存在
ipcMain.handle('localFs:exists', async (_event, filePath: string) => {
  try {
    const exists = await localFsService.exists(filePath)
    return { success: true, data: exists }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '检查路径失败' 
    }
  }
})

// 创建目录
ipcMain.handle('localFs:mkdir', async (_event, dirPath: string) => {
  try {
    await localFsService.mkdir(dirPath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '创建目录失败' 
    }
  }
})

// 删除文件
ipcMain.handle('localFs:delete', async (_event, filePath: string) => {
  try {
    await localFsService.delete(filePath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '删除文件失败' 
    }
  }
})

// 删除目录
ipcMain.handle('localFs:rmdir', async (_event, dirPath: string) => {
  try {
    await localFsService.rmdir(dirPath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '删除目录失败' 
    }
  }
})

// 重命名/移动
ipcMain.handle('localFs:rename', async (_event, oldPath: string, newPath: string) => {
  try {
    await localFsService.rename(oldPath, newPath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '重命名失败' 
    }
  }
})

// 复制文件
ipcMain.handle('localFs:copyFile', async (_event, src: string, dest: string) => {
  try {
    await localFsService.copyFile(src, dest)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '复制文件失败' 
    }
  }
})

// 复制目录
ipcMain.handle('localFs:copyDir', async (_event, src: string, dest: string) => {
  try {
    await localFsService.copyDir(src, dest)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '复制目录失败' 
    }
  }
})

// 读取文本文件
ipcMain.handle('localFs:readFile', async (_event, filePath: string) => {
  try {
    const content = await localFsService.readFile(filePath)
    return { success: true, data: content }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '读取文件失败' 
    }
  }
})

// 写入文本文件
ipcMain.handle('localFs:writeFile', async (_event, filePath: string, content: string) => {
  try {
    await localFsService.writeFile(filePath, content)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '写入文件失败' 
    }
  }
})

// 获取上级目录
ipcMain.handle('localFs:getParentDir', async (_event, filePath: string) => {
  return localFsService.getParentDir(filePath)
})

// 拼接路径
ipcMain.handle('localFs:joinPath', async (_event, ...parts: string[]) => {
  return localFsService.joinPath(...parts)
})

// 获取路径分隔符
ipcMain.handle('localFs:getSeparator', async () => {
  return localFsService.getSeparator()
})

// 获取常用目录
ipcMain.handle('localFs:getSpecialFolders', async () => {
  return localFsService.getSpecialFolders()
})

// 在系统文件管理器中显示
ipcMain.handle('localFs:showInExplorer', async (_event, filePath: string) => {
  return localFsService.showInExplorer(filePath)
})

// 用系统默认程序打开
ipcMain.handle('localFs:openFile', async (_event, filePath: string) => {
  return localFsService.openFile(filePath)
})

// ==================== 文件管理器窗口相关 ====================

// 打开文件管理器窗口
ipcMain.handle('fileManager:open', async (_event, config: {
  sessionId?: string
  sftpConfig?: SftpConfig
  initialLocalPath?: string
  initialRemotePath?: string
}) => {
  createFileManagerWindow(config)
  return { success: true }
})

// 关闭文件管理器窗口
ipcMain.handle('fileManager:close', async () => {
  if (fileManagerWindow && !fileManagerWindow.isDestroyed()) {
    fileManagerWindow.close()
  }
})

// 获取窗口初始化参数
ipcMain.handle('fileManager:getInitParams', async () => {
  return fileManagerParams
})

// ==================== SFTP 相关 ====================

// SFTP 传输进度事件转发（发送到主窗口和文件管理器窗口）
sftpService.on('transfer-start', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-start', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-start', progress)
})
sftpService.on('transfer-progress', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-progress', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-progress', progress)
})
sftpService.on('transfer-complete', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-complete', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-complete', progress)
})
sftpService.on('transfer-error', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-error', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-error', progress)
})
sftpService.on('transfer-cancelled', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-cancelled', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-cancelled', progress)
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
  console.log(`[SFTP] list 请求: sessionId=${sessionId}, remotePath=${remotePath}`)
  try {
    const { files, resolvedPath } = await sftpService.list(sessionId, remotePath)
    console.log(`[SFTP] list 结果: resolvedPath=${resolvedPath}, 文件数=${files.length}`)
    return { success: true, data: files, resolvedPath }
  } catch (error) {
    console.error(`[SFTP] list 失败:`, error)
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

// 取消传输
ipcMain.handle('sftp:cancelTransfer', async (_event, transferId: string) => {
  try {
    const cancelled = sftpService.cancelTransfer(transferId)
    return { success: cancelled }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '取消失败'
    }
  }
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

// ==================== 用户技能相关 ====================

// 获取所有用户技能列表
ipcMain.handle('userSkill:list', async (): Promise<UserSkill[]> => {
  return getUserSkillService().getAllSkills()
})

// 刷新技能列表
ipcMain.handle('userSkill:refresh', async (): Promise<UserSkill[]> => {
  return getUserSkillService().refresh()
})

// 启用/禁用技能
ipcMain.handle('userSkill:toggle', async (_event, skillId: string, enabled: boolean): Promise<boolean> => {
  return getUserSkillService().toggleSkill(skillId, enabled)
})

// 打开技能目录
ipcMain.handle('userSkill:openFolder', async (): Promise<void> => {
  await getUserSkillService().openSkillsFolder()
})

// 获取技能完整内容
ipcMain.handle('userSkill:getContent', async (_event, skillId: string): Promise<string | null> => {
  return getUserSkillService().getSkillContent(skillId)
})

// 获取技能目录路径
ipcMain.handle('userSkill:getSkillsDir', async (): Promise<string> => {
  return getUserSkillService().getSkillsDir()
})

// ==================== 技能市场相关 ====================

function getMarketService() {
  return getSkillMarketService(configService, getUserSkillService())
}

ipcMain.handle('skillMarket:list', async (_event, force?: boolean): Promise<MarketSkillItem[]> => {
  return getMarketService().listSkills(force)
})

ipcMain.handle('skillMarket:search', async (_event, query: string): Promise<MarketSkillItem[]> => {
  return getMarketService().searchSkills(query)
})

ipcMain.handle('skillMarket:install', async (_event, skillId: string): Promise<SkillOperationResult> => {
  return getMarketService().installSkill(skillId)
})

ipcMain.handle('skillMarket:uninstall', async (_event, skillId: string): Promise<SkillOperationResult> => {
  return getMarketService().uninstallSkill(skillId)
})

ipcMain.handle('skillMarket:update', async (_event, skillId: string): Promise<SkillOperationResult> => {
  return getMarketService().updateSkill(skillId)
})

ipcMain.handle('skillMarket:getRegistryUrl', async (): Promise<string> => {
  return getMarketService().getRegistryUrl()
})

ipcMain.handle('skillMarket:setRegistryUrl', async (_event, url: string): Promise<void> => {
  getMarketService().setRegistryUrl(url)
})

ipcMain.handle('skillMarket:fetchRegistry', async (_event, force?: boolean): Promise<SkillRegistry> => {
  return getMarketService().fetchRegistry(force)
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
    // 只有全部删除成功才返回 success: true
    return { 
      success: result.failed === 0, 
      deleted: result.success, 
      failed: result.failed,
      error: result.failed > 0 ? `${result.failed} 个文档删除失败` : undefined
    }
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
  const docs = getKnowledge().getDocuments()
  // 解密主机记忆内容（用于前端显示）
  return docs.map(doc => {
    if (doc.fileType === 'host-memory') {
      return {
        ...doc,
        content: decrypt(doc.content)
      }
    }
    return doc
  })
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
// 检查知识库初始化是否完成
ipcMain.handle('knowledge:isInitialized', async () => {
  return isKnowledgeReady()
})

// 等待知识库初始化完成
ipcMain.handle('knowledge:waitInitialized', async () => {
  await waitForKnowledge()
  return true
})

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

// ==================== 知识文档（L2 Context Knowledge） ====================

ipcMain.handle('contextKnowledge:list', async () => {
  try {
    const { getContextKnowledgeService } = await import('./services/knowledge/context-knowledge')
    const service = getContextKnowledgeService()
    const ids = service.listContextIds()
    const items = ids.map(id => ({
      contextId: id,
      content: service.getDocument(id)
    }))
    return { success: true, items }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '获取列表失败', items: [] }
  }
})

ipcMain.handle('contextKnowledge:get', async (_event, contextId: string) => {
  try {
    const { getContextKnowledgeService } = await import('./services/knowledge/context-knowledge')
    return { success: true, content: getContextKnowledgeService().getDocument(contextId) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '获取文档失败', content: '' }
  }
})

ipcMain.handle('contextKnowledge:set', async (_event, contextId: string, content: string) => {
  try {
    const { getContextKnowledgeService } = await import('./services/knowledge/context-knowledge')
    getContextKnowledgeService().setDocument(contextId, content)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '保存文档失败' }
  }
})

ipcMain.handle('contextKnowledge:delete', async (_event, contextId: string) => {
  try {
    const { getContextKnowledgeService } = await import('./services/knowledge/context-knowledge')
    getContextKnowledgeService().deleteDocument(contextId)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '删除文档失败' }
  }
})

// ==================== 邮箱相关 ====================

// 设置邮箱凭据
ipcMain.handle('email:setCredential', async (_event, accountId: string, credential: string) => {
  const { setEmailCredential } = await import('./services/credential.service')
  await setEmailCredential(accountId, credential)
})

// 删除邮箱凭据
ipcMain.handle('email:deleteCredential', async (_event, accountId: string) => {
  const { deleteEmailCredential } = await import('./services/credential.service')
  return await deleteEmailCredential(accountId)
})

// 同步邮箱账户配置到 email skill + email sensor
ipcMain.handle('email:syncAccounts', async (_event, accounts: Array<{
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
}>) => {
  const { setEmailAccounts } = await import('./services/agent/skills/email/executor')
  setEmailAccounts(accounts)

  // 同步到 EmailSensor（利用 email skill 的 getServerConfig 填充 IMAP host/port）
  try {
    const { getServerConfig } = await import('./services/agent/skills/email/session')
    const { getEmailCredential } = await import('./services/credential.service')

    const sensorAccounts = accounts.map(a => {
      const server = getServerConfig(a.provider, {
        imapHost: a.imapHost,
        imapPort: a.imapPort
      })
      return {
        accountId: a.id,
        email: a.email,
        provider: a.provider,
        imapHost: server.imapHost,
        imapPort: server.imapPort,
        rejectUnauthorized: a.rejectUnauthorized
      }
    }).filter(a => a.imapHost)

    await sensorService.email.configureAccounts(
      sensorAccounts,
      (accountId) => getEmailCredential(accountId)
    )

    console.log(`[Email] Synced ${accounts.length} account(s) to skill + ${sensorAccounts.length} to sensor`)
  } catch (err) {
    console.error('[Email] Failed to sync accounts to sensor:', err)
  }
})

// 测试邮箱连接
ipcMain.handle('email:testConnection', async (_event, config: {
  email: string
  password: string
  provider?: string
  imapHost?: string
  imapPort?: number
  rejectUnauthorized?: boolean
}) => {
  try {
    const { getServerConfig } = await import('./services/agent/skills/email/session')
    const serverConfig = getServerConfig(config.provider || 'gmail', {
      imapHost: config.imapHost,
      imapPort: config.imapPort
    })

    const { ImapFlow } = await import('imapflow')
    const client = new ImapFlow({
      host: serverConfig.imapHost,
      port: serverConfig.imapPort,
      secure: true,
      auth: {
        user: config.email,
        pass: config.password
      },
      logger: false,
      tls: {
        rejectUnauthorized: config.rejectUnauthorized !== false
      }
    })

    await client.connect()
    await client.logout()

    return { success: true, message: '连接成功' }
  } catch (error) {
    return { 
      success: false, 
      message: error instanceof Error ? error.message : '连接失败'
    }
  }
})

// 验证已保存的邮箱账户（从 keychain 读取密码）
ipcMain.handle('email:verifyAccount', async (_event, account: {
  id: string
  email: string
  provider?: string
  imapHost?: string
  imapPort?: number
  rejectUnauthorized?: boolean
}) => {
  if (!account.id || !account.email) {
    return { success: false, message: '无效的账户信息' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null
  try {
    const { getEmailCredential } = await import('./services/credential.service')
    const password = await getEmailCredential(account.id)
    if (!password) {
      return { success: false, message: '未找到保存的凭据，请重新编辑账户并输入密码' }
    }

    const { getServerConfig } = await import('./services/agent/skills/email/session')
    const serverConfig = getServerConfig(account.provider || 'gmail', {
      imapHost: account.imapHost,
      imapPort: account.imapPort
    })

    const { ImapFlow } = await import('imapflow')
    client = new ImapFlow({
      host: serverConfig.imapHost,
      port: serverConfig.imapPort,
      secure: true,
      auth: {
        user: account.email,
        pass: password
      },
      logger: false,
      tls: {
        rejectUnauthorized: account.rejectUnauthorized !== false
      }
    })

    await client.connect()
    return { success: true, message: '连接正常' }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : '连接失败'
    }
  } finally {
    try { await client?.logout() } catch { /* ignore logout errors */ }
  }
})

// ==================== 日历相关 ====================

// 设置日历凭据
ipcMain.handle('calendar:setCredential', async (_event, accountId: string, credential: string) => {
  const { setCalendarCredential } = await import('./services/credential.service')
  await setCalendarCredential(accountId, credential)
})

// 删除日历凭据
ipcMain.handle('calendar:deleteCredential', async (_event, accountId: string) => {
  const { deleteCalendarCredential } = await import('./services/credential.service')
  return await deleteCalendarCredential(accountId)
})

// 同步日历账户配置到 calendar skill + calendar sensor
ipcMain.handle('calendar:syncAccounts', async (_event, accounts: Array<{
  id: string
  name: string
  provider: string
  username: string
  serverUrl?: string
}>) => {
  const { setCalendarAccounts } = await import('./services/agent/skills/calendar/executor')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setCalendarAccounts(accounts as any)

  // 同步到 CalendarSensor
  try {
    const { getCalendarCredential } = await import('./services/credential.service')

    const sensorAccounts = accounts.map(a => ({
      accountId: a.id,
      name: a.name,
      provider: a.provider,
      username: a.username,
      serverUrl: a.serverUrl
    }))

    await sensorService.calendar.configureAccounts(
      sensorAccounts,
      (accountId) => getCalendarCredential(accountId)
    )

    console.log(`[Calendar] Synced ${accounts.length} account(s) to skill + sensor`)
  } catch (err) {
    console.error('[Calendar] Failed to sync accounts to sensor:', err)
  }
})

// 测试日历连接
ipcMain.handle('calendar:testConnection', async (_event, config: {
  username: string
  password: string
  provider?: string
  serverUrl?: string
}) => {
  try {
    const tsdav = await import('tsdav')
    
    const client = new tsdav.DAVClient({
      serverUrl: config.serverUrl || 'https://caldav.wecom.work',
      credentials: {
        username: config.username,
        password: config.password
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })

    await client.login()
    const calendars = await client.fetchCalendars()
    
    return { 
      success: true, 
      message: `连接成功，找到 ${calendars.length} 个日历` 
    }
  } catch (error) {
    return { 
      success: false, 
      message: error instanceof Error ? error.message : '连接失败'
    }
  }
})

// 验证已保存的日历账户（从 keychain 读取密码）
ipcMain.handle('calendar:verifyAccount', async (_event, account: {
  id: string
  username: string
  provider?: string
  serverUrl?: string
}) => {
  if (!account.id || !account.username) {
    return { success: false, message: '无效的账户信息' }
  }

  try {
    const { getCalendarCredential } = await import('./services/credential.service')
    const password = await getCalendarCredential(account.id)
    if (!password) {
      return { success: false, message: '未找到保存的凭据，请重新编辑账户并输入密码' }
    }

    const tsdav = await import('tsdav')
    const client = new tsdav.DAVClient({
      serverUrl: account.serverUrl || 'https://caldav.wecom.work',
      credentials: {
        username: account.username,
        password
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })

    await client.login()
    const calendars = await client.fetchCalendars()

    return {
      success: true,
      message: `连接正常，找到 ${calendars.length} 个日历`
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : '连接失败'
    }
  }
})

// ==================== 语音识别相关 ====================
// 使用 sherpa-onnx-node + Paraformer 模型

// 获取语音识别状态
ipcMain.handle('speech:getStatus', async () => {
  const { getStatus } = await import('./services/speech')
  return getStatus()
})

// 获取模型信息
ipcMain.handle('speech:getModelInfo', async () => {
  const { getModelInfo } = await import('./services/speech')
  return getModelInfo()
})

// 初始化语音识别服务
ipcMain.handle('speech:initialize', async () => {
  const { initialize } = await import('./services/speech')
  return initialize()
})

// 转录音频数据
ipcMain.handle('speech:transcribe', async (_event, audioData: number[], sampleRate: number = 16000) => {
  try {
    const { transcribe } = await import('./services/speech')
    const float32Data = new Float32Array(audioData)
    return await transcribe(float32Data, sampleRate)
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '转录失败' 
    }
  }
})

// 检查服务是否就绪
ipcMain.handle('speech:isReady', async () => {
  const { isReady } = await import('./services/speech')
  return isReady()
})

