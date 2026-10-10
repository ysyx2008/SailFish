/**
 * 启动期懒加载服务注册表
 *
 * 重型原生模块（node-pty、ssh2）及 Agent/终端链在首次使用时才 dynamic import，
 * 避免低配 Windows 在出窗口前被 Defender 扫描 .node 同步阻塞。
 *
 * 首屏仅需 Config / History / 窗口 IPC 的轻量路径不触发本模块。
 */
import type { BrowserWindow } from 'electron'
import type { AiService } from './ai.service'
import type { ConfigService } from './config.service'
import type { HostProfileService } from './host-profile.service'
import type { HistoryService } from './history.service'
import type { McpService } from './mcp.service'
import type { PtyService } from './pty.service'
import type { SshService } from './ssh.service'
import type { SftpService } from './sftp.service'
import type { AgentService } from './agent'
import type { AgentCallbacks } from './agent/types'
import type { PluginRegistry } from './plugin/registry' // PluginRegistry class
import type {
  CwdChangeEvent,
  CommandExecutionEvent,
  TerminalStateService,
} from './terminal-state.service'
import type { TerminalAwarenessService } from './terminal-awareness'
import { createLogger } from '../utils/logger'

const log = createLogger('StartupRegistry')

export interface AgentRuntimeDeps {
  aiService: AiService
  hostProfileService: HostProfileService
  mcpService: McpService
  configService: ConfigService
  historyService: HistoryService
  pluginRegistry: PluginRegistry
  appStartTime: number
  /** 别处发起的一句（联络替用户说的等）推到界面用的回调；没有窗口时返回 undefined */
  uiCallbacksFor?: (agentKey: string) => AgentCallbacks | undefined
}

export interface AgentRuntime {
  ptyService: PtyService
  sshService: SshService
  sftpService: SftpService
  agentService: AgentService
  terminalStateService: TerminalStateService
  terminalAwarenessService: TerminalAwarenessService
}

let runtime: AgentRuntime | null = null
let runtimePromise: Promise<AgentRuntime> | null = null
let sftpListenersAttached = false
let terminalIpcBridgeAttached = false

type TerminalEventSender = {
  sendTerminalCwdChange: (event: CwdChangeEvent) => void
  sendCommandExecution: (event: CommandExecutionEvent) => void
}

let terminalEventSender: TerminalEventSender | null = null

/** 由 main 在 createWindow / 窗口重建时注册，runtime 初始化后自动挂监听 */
export function setTerminalEventSender(sender: TerminalEventSender | null): void {
  terminalEventSender = sender
  if (runtime && sender && !terminalIpcBridgeAttached) {
    attachTerminalIpcBridge(runtime.terminalStateService, sender)
  }
}

function attachTerminalIpcBridge(
  terminalStateService: TerminalStateService,
  sender: TerminalEventSender
): void {
  if (terminalIpcBridgeAttached) return
  terminalIpcBridgeAttached = true
  terminalStateService.onCwdChange((event) => sender.sendTerminalCwdChange(event))
  terminalStateService.onCommandExecution((event) => sender.sendCommandExecution(event))
}

function attachSftpProgressBridge(
  sftpService: SftpService,
  getWindows: () => { main: BrowserWindow | null; fileManager: BrowserWindow | null }
): void {
  if (sftpListenersAttached) return
  sftpListenersAttached = true
  const forward = (channel: string, progress: unknown) => {
    const { main, fileManager } = getWindows()
    main?.webContents.send(channel, progress)
    fileManager?.webContents.send(channel, progress)
  }
  sftpService.on('transfer-start', (p) => forward('sftp:transfer-start', p))
  sftpService.on('transfer-progress', (p) => forward('sftp:transfer-progress', p))
  sftpService.on('transfer-complete', (p) => forward('sftp:transfer-complete', p))
  sftpService.on('transfer-error', (p) => forward('sftp:transfer-error', p))
  sftpService.on('transfer-cancelled', (p) => forward('sftp:transfer-cancelled', p))
}

export function getAgentRuntimeOrNull(): AgentRuntime | null {
  return runtime
}

export async function ensureAgentRuntime(deps: AgentRuntimeDeps): Promise<AgentRuntime> {
  if (runtime) return runtime
  if (!runtimePromise) {
    runtimePromise = loadAgentRuntime(deps).catch((err) => {
      runtimePromise = null
      throw err
    })
  }
  return runtimePromise
}

async function loadAgentRuntime(deps: AgentRuntimeDeps): Promise<AgentRuntime> {
  const loadStart = Date.now()
  log.info(`[startup] lazy loading agent/terminal runtime (+${Date.now() - deps.appStartTime}ms)`)

  const [
    { PtyService },
    { SshService },
    { SftpService },
    { AgentService },
    { initTerminalStateService },
    { initTerminalAwarenessService },
  ] = await Promise.all([
    import('./pty.service'),
    import('./ssh.service'),
    import('./sftp.service'),
    import('./agent'),
    import('./terminal-state.service'),
    import('./terminal-awareness'),
  ])

  const ptyService = new PtyService()
  const sshService = new SshService()
  const sftpService = new SftpService()
  const agentService = new AgentService(
    deps.aiService,
    ptyService,
    deps.hostProfileService,
    deps.mcpService,
    deps.configService,
    sshService
  )
  agentService.setHistoryService(deps.historyService)
  agentService.setUiCallbacksFactory(deps.uiCallbacksFor)
  agentService.setSftpService(sftpService)
  agentService.setPluginRegistry(deps.pluginRegistry)

  const terminalStateService = initTerminalStateService(ptyService, sshService)
  const terminalAwarenessService = initTerminalAwarenessService(
    ptyService,
    terminalStateService,
    sshService
  )

  if (terminalEventSender) {
    attachTerminalIpcBridge(terminalStateService, terminalEventSender)
  }

  const loaded: AgentRuntime = {
    ptyService,
    sshService,
    sftpService,
    agentService,
    terminalStateService,
    terminalAwarenessService,
  }
  runtime = loaded

  log.info(
    `[startup] agent/terminal runtime ready (+${Date.now() - deps.appStartTime}ms, load ${Date.now() - loadStart}ms)`
  )
  return loaded
}

/** SFTP 进度桥：在 main 注册 getWindows 回调，首次加载 runtime 时挂事件 */
let sftpWindowGetter: (() => { main: BrowserWindow | null; fileManager: BrowserWindow | null }) | null = null

export function registerSftpWindowGetter(
  getter: () => { main: BrowserWindow | null; fileManager: BrowserWindow | null }
): void {
  sftpWindowGetter = getter
}

export async function ensureSftpProgressBridge(deps: AgentRuntimeDeps): Promise<void> {
  const rt = await ensureAgentRuntime(deps)
  if (sftpWindowGetter) {
    attachSftpProgressBridge(rt.sftpService, sftpWindowGetter)
  }
}

/** 退出清理：仅清理已加载过的服务 */
export function disposeAgentRuntimeIfLoaded(): void {
  if (!runtime) return
  runtime.ptyService.disposeAll()
  runtime.sshService.disposeAll()
  runtime.sftpService.disconnectAll()
}
