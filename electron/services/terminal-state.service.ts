/**
 * 终端状态服务
 * 集中管理终端的运行时状态，包括 CWD 追踪、命令执行状态等
 */
import type { PtyService } from './pty.service'
import type { SshService } from './ssh.service'
import { getScreenAnalysisFromFrontend } from './screen-content.service'

export interface TerminalState {
  /** 终端 ID (ptyId 或 sshId) */
  id: string
  /** 终端类型 */
  type: 'local' | 'ssh'
  /** 当前工作目录 */
  cwd: string
  /** CWD 最后更新时间 */
  cwdUpdatedAt: number
  /** 最后执行的命令 */
  lastCommand?: string
  /** 最后命令的退出码 */
  lastExitCode?: number
  /** 终端是否空闲 */
  isIdle: boolean
  /** 最后活动时间 */
  lastActivityAt: number
  /** 当前正在执行的命令 */
  currentExecution?: CommandExecution
  /** 最近的命令执行历史（最多保留 20 条） */
  executionHistory: CommandExecution[]
}

export interface CwdChangeEvent {
  terminalId: string
  oldCwd: string
  newCwd: string
  timestamp: number
  trigger: 'command' | 'pwd_check' | 'initial'
}

/**
 * 命令执行记录
 */
export interface CommandExecution {
  /** 唯一标识 */
  id: string
  /** 终端 ID */
  terminalId: string
  /** 命令内容 */
  command: string
  /** 开始时间 */
  startTime: number
  /** 结束时间 */
  endTime?: number
  /** 执行耗时（毫秒） */
  duration?: number
  /** 退出码 */
  exitCode?: number
  /** 命令输出（限制长度） */
  output?: string
  /** 执行前的 CWD */
  cwdBefore: string
  /** 执行后的 CWD */
  cwdAfter?: string
  /** 执行状态 */
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
}

/**
 * 命令执行事件
 */
export interface CommandExecutionEvent {
  type: 'start' | 'output' | 'complete'
  execution: CommandExecution
}

// CWD 变化命令的正则模式
const CWD_CHANGE_PATTERNS = [
  // cd 命令
  /^\s*cd\s+(.+?)\s*$/,
  /^\s*cd\s*$/,  // cd 不带参数（回到 home）
  // pushd/popd
  /^\s*pushd\s+(.+?)\s*$/,
  /^\s*pushd\s*$/,
  /^\s*popd\s*$/,
  // z/zoxide 等快速跳转工具
  /^\s*z\s+(.+?)\s*$/,
  /^\s*j\s+(.+?)\s*$/,  // autojump
  // 其他可能改变目录的命令
  /^\s*builtin\s+cd\s+(.+?)\s*$/,
]

// 用于解析 pwd 输出的模式
const PWD_OUTPUT_PATTERN = /^(\/[^\n\r]*|[A-Z]:\\[^\n\r]*)$/m

export class TerminalStateService {
  private states: Map<string, TerminalState> = new Map()
  private ptyService?: PtyService
  private sshService?: SshService
  private cwdChangeCallbacks: ((event: CwdChangeEvent) => void)[] = []
  private commandExecutionCallbacks: ((event: CommandExecutionEvent) => void)[] = []
  
  // CWD 检查的最小间隔（毫秒）
  private readonly CWD_CHECK_INTERVAL = 5000
  // 命令执行历史的最大长度
  private readonly MAX_EXECUTION_HISTORY = 20
  // 命令输出的最大长度
  private readonly MAX_OUTPUT_LENGTH = 5000
  // 命令执行计数器
  private executionCounter = 0

  constructor(ptyService?: PtyService, sshService?: SshService) {
    this.ptyService = ptyService
    this.sshService = sshService
  }

  /**
   * 设置 PTY 服务
   */
  setPtyService(ptyService: PtyService): void {
    this.ptyService = ptyService
  }

  /**
   * 设置 SSH 服务
   */
  setSshService(sshService: SshService): void {
    this.sshService = sshService
  }

  /**
   * 初始化终端状态
   */
  initTerminal(id: string, type: 'local' | 'ssh', initialCwd?: string): void {
    const state: TerminalState = {
      id,
      type,
      cwd: initialCwd || (type === 'local' ? process.env.HOME || '~' : '~'),
      cwdUpdatedAt: Date.now(),
      isIdle: true,
      lastActivityAt: Date.now(),
      executionHistory: []
    }
    this.states.set(id, state)
  }

  /**
   * 移除终端状态
   */
  removeTerminal(id: string): void {
    this.states.delete(id)
  }

  /**
   * 获取终端状态
   */
  getState(id: string): TerminalState | undefined {
    return this.states.get(id)
  }

  /**
   * 获取当前工作目录
   */
  getCwd(id: string): string {
    return this.states.get(id)?.cwd || '~'
  }

  /**
   * 注册 CWD 变化回调
   */
  onCwdChange(callback: (event: CwdChangeEvent) => void): () => void {
    this.cwdChangeCallbacks.push(callback)
    return () => {
      const index = this.cwdChangeCallbacks.indexOf(callback)
      if (index !== -1) {
        this.cwdChangeCallbacks.splice(index, 1)
      }
    }
  }

  /**
   * 触发 CWD 变化事件
   */
  private emitCwdChange(event: CwdChangeEvent): void {
    for (const callback of this.cwdChangeCallbacks) {
      try {
        callback(event)
      } catch (e) {
        console.error('[TerminalStateService] CWD change callback error:', e)
      }
    }
  }

  /**
   * 分析用户输入，检测可能改变 CWD 的命令
   */
  analyzeInput(id: string, input: string): { mayChangeCwd: boolean; targetPath?: string } {
    // 去除命令中的控制字符
    const cleanInput = input.replace(/[\r\n]/g, '').trim()
    
    for (const pattern of CWD_CHANGE_PATTERNS) {
      const match = cleanInput.match(pattern)
      if (match) {
        // match[1] 是目标路径（如果有）
        return {
          mayChangeCwd: true,
          targetPath: match[1]?.trim()
        }
      }
    }

    return { mayChangeCwd: false }
  }

  /**
   * 处理用户输入
   * 在用户输入命令后调用，用于追踪可能的 CWD 变化
   */
  handleInput(id: string, input: string): void {
    const state = this.states.get(id)
    if (!state) return

    state.lastActivityAt = Date.now()

    // 检测是否是可能改变 CWD 的命令
    const analysis = this.analyzeInput(id, input)
    if (analysis.mayChangeCwd) {
      state.lastCommand = input.replace(/[\r\n]/g, '').trim()
      
      // 延迟检查 CWD（等待命令执行完成）
      setTimeout(() => {
        // macOS/Linux: 直接使用系统调用获取 CWD，结果可靠，无需预测
        // Windows: 系统调用不可靠，可能需要根据命令预测 CWD
        if (process.platform === 'win32' && state.type === 'local') {
          this.refreshCwd(id, 'command').then(newCwd => {
            // Windows: 如果系统调用失败，尝试根据 cd 命令参数预测
            if (newCwd === state.cwd && analysis.targetPath !== undefined) {
              const predictedCwd = this.resolveCwdPath(state.cwd, analysis.targetPath)
              if (predictedCwd && predictedCwd !== state.cwd) {
                this.updateCwd(id, predictedCwd, 'command')
              }
            }
          })
        } else {
          // macOS/Linux/SSH: 直接刷新，信任系统调用结果
          this.refreshCwd(id, 'command')
        }
      }, 500)
    }
  }

  /**
   * 刷新 CWD（优先通过系统调用，避免在终端中执行命令）
   */
  async refreshCwd(id: string, trigger: 'command' | 'pwd_check' | 'initial' = 'pwd_check'): Promise<string> {
    const state = this.states.get(id)
    if (!state) return '~'

    // 检查距离上次更新的时间间隔
    const now = Date.now()
    if (trigger === 'pwd_check' && now - state.cwdUpdatedAt < this.CWD_CHECK_INTERVAL) {
      return state.cwd
    }

    try {
      let newCwd: string | null = null

      if (state.type === 'local' && this.ptyService) {
        // 本地终端：优先使用系统调用获取 CWD（无需在终端中执行命令）
        newCwd = await this.ptyService.getCwd(id)
        
        // 如果系统调用失败，回退到执行 pwd 命令（仅用于初始化场景）
        if (!newCwd && trigger === 'initial') {
          const result = await this.ptyService.executeInTerminal(id, 'pwd', 3000)
          newCwd = this.parsePwdOutput(result.output)
        }
      } else if (state.type === 'ssh') {
        // SSH 终端：从终端屏幕提示符解析 CWD
        // exec channel 会创建新会话，无法获取当前 shell 的 CWD
        console.log(`[TerminalStateService] refreshCwd: SSH 终端 ${id}, 从屏幕分析获取 CWD`)
        const analysis = await getScreenAnalysisFromFrontend(id, 2000)
        console.log(`[TerminalStateService] refreshCwd: SSH 终端 ${id}, 屏幕分析结果:`, JSON.stringify(analysis?.context, null, 2))
        if (analysis?.context?.cwdFromPrompt) {
          // 从提示符解析到的路径可能是 ~ 开头，需要展开
          const cwdFromPrompt = analysis.context.cwdFromPrompt
          console.log(`[TerminalStateService] refreshCwd: SSH 终端 ${id}, 提示符 CWD: ${cwdFromPrompt}`)
          if (cwdFromPrompt.startsWith('~')) {
            // 对于 ~ 路径，保持原样，SFTP 服务会处理
            newCwd = cwdFromPrompt
          } else {
            newCwd = cwdFromPrompt
          }
        } else {
          console.log(`[TerminalStateService] refreshCwd: SSH 终端 ${id}, 无法从提示符获取 CWD, 可视内容:`, analysis?.visibleContent?.slice(-3))
        }
      }

      if (!newCwd) {
        state.cwdUpdatedAt = now
        return state.cwd
      }

      if (newCwd !== state.cwd) {
        const oldCwd = state.cwd
        state.cwd = newCwd
        state.cwdUpdatedAt = now

        // 触发 CWD 变化事件
        this.emitCwdChange({
          terminalId: id,
          oldCwd,
          newCwd,
          timestamp: now,
          trigger
        })
      } else {
        state.cwdUpdatedAt = now
      }

      return state.cwd
    } catch (error) {
      console.error('[TerminalStateService] Failed to refresh CWD:', error)
      return state.cwd
    }
  }

  /**
   * 解析 pwd 命令输出
   */
  private parsePwdOutput(output: string): string {
    // 去除 ANSI 转义序列
    const cleanOutput = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim()
    
    // 尝试匹配路径
    const match = cleanOutput.match(PWD_OUTPUT_PATTERN)
    if (match) {
      return match[1]
    }

    // 尝试获取最后一行非空内容
    const lines = cleanOutput.split('\n').filter(l => l.trim())
    const lastLine = lines[lines.length - 1]
    
    // 验证是否像路径
    if (lastLine && (lastLine.startsWith('/') || /^[A-Z]:\\/.test(lastLine))) {
      return lastLine.trim()
    }

    return ''
  }

  /**
   * 手动更新 CWD（用于已知 CWD 变化的情况）
   */
  updateCwd(id: string, newCwd: string, trigger: 'command' | 'pwd_check' | 'initial' = 'command'): void {
    const state = this.states.get(id)
    if (!state) return

    const oldCwd = state.cwd
    if (newCwd !== oldCwd) {
      state.cwd = newCwd
      state.cwdUpdatedAt = Date.now()

      this.emitCwdChange({
        terminalId: id,
        oldCwd,
        newCwd,
        timestamp: Date.now(),
        trigger
      })
    }
  }

  /**
   * 更新终端空闲状态
   */
  updateIdleState(id: string, isIdle: boolean): void {
    const state = this.states.get(id)
    if (state) {
      state.isIdle = isIdle
      state.lastActivityAt = Date.now()
    }
  }

  /**
   * 更新最后命令的退出码
   */
  updateLastExitCode(id: string, exitCode: number): void {
    const state = this.states.get(id)
    if (state) {
      state.lastExitCode = exitCode
    }
  }

  /**
   * 获取所有终端状态（用于调试）
   */
  getAllStates(): Map<string, TerminalState> {
    return new Map(this.states)
  }

  // ==================== 命令执行追踪 ====================

  /**
   * 注册命令执行事件回调
   */
  onCommandExecution(callback: (event: CommandExecutionEvent) => void): () => void {
    this.commandExecutionCallbacks.push(callback)
    return () => {
      const index = this.commandExecutionCallbacks.indexOf(callback)
      if (index !== -1) {
        this.commandExecutionCallbacks.splice(index, 1)
      }
    }
  }

  /**
   * 触发命令执行事件
   */
  private emitCommandExecution(event: CommandExecutionEvent): void {
    for (const callback of this.commandExecutionCallbacks) {
      try {
        callback(event)
      } catch (e) {
        console.error('[TerminalStateService] Command execution callback error:', e)
      }
    }
  }

  /**
   * 开始追踪一个命令执行
   */
  startCommandExecution(id: string, command: string): CommandExecution | null {
    const state = this.states.get(id)
    if (!state) return null

    const execution: CommandExecution = {
      id: `cmd_${Date.now()}_${++this.executionCounter}`,
      terminalId: id,
      command: command.trim(),
      startTime: Date.now(),
      cwdBefore: state.cwd,
      status: 'running',
      output: ''
    }

    state.currentExecution = execution
    state.isIdle = false
    state.lastCommand = command.trim()
    state.lastActivityAt = Date.now()

    // 触发开始事件
    this.emitCommandExecution({
      type: 'start',
      execution: { ...execution }
    })

    return execution
  }

  /**
   * 追加命令输出
   */
  appendCommandOutput(id: string, output: string): void {
    const state = this.states.get(id)
    if (!state?.currentExecution) return

    const execution = state.currentExecution
    
    // 追加输出
    execution.output = (execution.output || '') + output
    
    // 限制输出长度：保留最新的内容（末尾），截断标记放在最前面
    if (execution.output.length > this.MAX_OUTPUT_LENGTH) {
      execution.output = '... [前面内容已省略]\n' + execution.output.slice(-this.MAX_OUTPUT_LENGTH)
    }

    state.lastActivityAt = Date.now()

    // 触发输出事件
    this.emitCommandExecution({
      type: 'output',
      execution: { ...execution }
    })
  }

  /**
   * 完成命令执行
   */
  completeCommandExecution(
    id: string,
    exitCode?: number,
    status: 'completed' | 'failed' | 'timeout' | 'cancelled' = 'completed'
  ): CommandExecution | null {
    const state = this.states.get(id)
    if (!state?.currentExecution) return null

    const execution = state.currentExecution
    execution.endTime = Date.now()
    execution.duration = execution.endTime - execution.startTime
    execution.exitCode = exitCode
    execution.status = exitCode === 0 ? 'completed' : (status === 'completed' ? 'failed' : status)
    execution.cwdAfter = state.cwd

    // 更新状态
    state.lastExitCode = exitCode
    state.isIdle = true
    state.lastActivityAt = Date.now()
    state.currentExecution = undefined

    // 添加到历史记录
    state.executionHistory.push({ ...execution })
    
    // 限制历史记录长度
    while (state.executionHistory.length > this.MAX_EXECUTION_HISTORY) {
      state.executionHistory.shift()
    }

    // 触发完成事件
    this.emitCommandExecution({
      type: 'complete',
      execution: { ...execution }
    })

    return execution
  }

  /**
   * 获取当前正在执行的命令
   */
  getCurrentExecution(id: string): CommandExecution | undefined {
    return this.states.get(id)?.currentExecution
  }

  /**
   * 获取命令执行历史
   */
  getExecutionHistory(id: string, limit?: number): CommandExecution[] {
    const state = this.states.get(id)
    if (!state) return []
    
    const history = [...state.executionHistory]
    if (limit && limit > 0) {
      return history.slice(-limit)
    }
    return history
  }

  /**
   * 获取最后一次命令执行
   */
  getLastExecution(id: string): CommandExecution | undefined {
    const state = this.states.get(id)
    if (!state) return undefined
    
    return state.executionHistory[state.executionHistory.length - 1]
  }

  /**
   * 清除命令执行历史
   */
  clearExecutionHistory(id: string): void {
    const state = this.states.get(id)
    if (state) {
      state.executionHistory = []
    }
  }

  /**
   * 解析可能的 CWD 目标路径
   * 用于预测 cd 命令后的新路径
   */
  resolveCwdPath(currentCwd: string, targetPath: string): string {
    // 检测是否是 Windows 风格路径
    const isWindows = process.platform === 'win32' || /^[A-Z]:[/\\]/i.test(currentCwd)
    const sep = isWindows ? '\\' : '/'
    
    // 规范化路径分隔符（Windows 路径可能混用 / 和 \）
    const normalizePath = (p: string): string => {
      if (isWindows) {
        return p.replace(/\//g, '\\')
      }
      return p
    }
    
    if (!targetPath) {
      // cd 不带参数，返回 home
      if (isWindows) {
        return process.env.USERPROFILE || process.env.HOME || 'C:\\'
      }
      return process.env.HOME || '~'
    }

    // 规范化目标路径
    targetPath = normalizePath(targetPath)

    // Windows 绝对路径
    if (/^[A-Z]:[/\\]/i.test(targetPath)) {
      return targetPath
    }
    
    // Unix 绝对路径
    if (targetPath.startsWith('/')) {
      return targetPath
    }

    // Home 目录展开
    if (targetPath === '~' || targetPath.startsWith('~' + sep) || targetPath.startsWith('~/')) {
      const home = isWindows 
        ? (process.env.USERPROFILE || process.env.HOME || '') 
        : (process.env.HOME || '')
      if (targetPath === '~') return home
      return home + sep + targetPath.slice(2)
    }

    if (targetPath === '.') {
      return currentCwd
    }

    // 分割路径
    const splitPath = (p: string): string[] => {
      return p.split(/[/\\]/).filter(part => part && part !== '.')
    }

    const baseParts = splitPath(currentCwd)
    const targetParts = splitPath(targetPath)
    
    // 检查当前路径是否以 ~ 开头（home 目录简写）
    const startsWithTilde = currentCwd.startsWith('~')
    
    // 保留 Windows 盘符或 Unix 路径前缀
    let prefix = ''
    if (isWindows && baseParts.length > 0 && /^[A-Z]:$/i.test(baseParts[0])) {
      prefix = baseParts.shift() + sep
    } else if (!isWindows && !startsWithTilde) {
      // 只有当路径不是以 ~ 开头时才添加 / 前缀
      prefix = '/'
    }

    // 处理 .. 和普通路径
    for (const part of targetParts) {
      if (part === '..') {
        if (baseParts.length > 0) {
          baseParts.pop()
        }
      } else {
        baseParts.push(part)
      }
    }

    return prefix + baseParts.join(sep)
  }
}

// 创建单例实例
let terminalStateServiceInstance: TerminalStateService | null = null

export function getTerminalStateService(): TerminalStateService {
  if (!terminalStateServiceInstance) {
    terminalStateServiceInstance = new TerminalStateService()
  }
  return terminalStateServiceInstance
}

export function initTerminalStateService(ptyService?: PtyService, sshService?: SshService): TerminalStateService {
  if (!terminalStateServiceInstance) {
    terminalStateServiceInstance = new TerminalStateService(ptyService, sshService)
  } else {
    if (ptyService) terminalStateServiceInstance.setPtyService(ptyService)
    if (sshService) terminalStateServiceInstance.setSshService(sshService)
  }
  return terminalStateServiceInstance
}
