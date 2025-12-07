/**
 * 进程状态监控器
 * 负责检测命令执行状态、卡死检测、输出速率分析等
 */
import type { PtyService } from '../pty.service'
import type { TerminalStateService, TerminalState, CommandExecution } from '../terminal-state.service'

/** 进程运行状态 */
export type ProcessStatus = 
  | 'idle'                // 空闲，等待输入
  | 'running_interactive' // 运行交互式程序（top, vim 等）
  | 'running_streaming'   // 运行持续输出的命令（tail -f 等）
  | 'running_silent'      // 运行但无输出（sleep, 长编译等）
  | 'possibly_stuck'      // 可能卡死
  | 'waiting_input'       // 等待用户输入

/** 进程状态详情 */
export interface ProcessState {
  /** 当前状态 */
  status: ProcessStatus
  /** 前台进程名称 */
  foregroundProcess?: string
  /** 前台进程 PID */
  pid?: number
  /** 已运行时长（毫秒）*/
  runningTime?: number
  /** 最后输出时间 */
  lastOutputTime?: number
  /** 输出速率（行/秒，最近 10 秒平均）*/
  outputRate?: number
  /** 是否是已知的长时间运行命令 */
  isKnownLongRunning?: boolean
  /** 建议操作 */
  suggestion?: string
}

/** 输出追踪器 */
interface OutputTracker {
  /** 最近 N 秒的输出行数记录 */
  recentOutputCounts: { timestamp: number; lineCount: number }[]
  /** 最后一次输出时间 */
  lastOutputTime: number
  /** 总输出行数 */
  totalLines: number
}

/** 已知的交互式命令（全屏） */
const INTERACTIVE_COMMANDS = [
  'vim', 'vi', 'nvim', 'nano', 'emacs',
  'top', 'htop', 'btop', 'glances',
  'less', 'more', 'man',
  'tmux', 'screen',
  'mc', 'ranger', 'nnn',
  'mutt', 'alpine',
]

/** 已知的持续输出命令 */
const STREAMING_COMMANDS = [
  'tail -f', 'tail -F', 'tail --follow',
  'docker logs -f', 'docker-compose logs -f',
  'kubectl logs -f',
  'journalctl -f',
  'watch',
  'npm run dev', 'npm start', 'yarn dev', 'yarn start',
  'pnpm dev', 'pnpm start',
  'python -m http.server', 'python3 -m http.server',
  'php -S', 'ruby -run',
  'cargo watch', 'nodemon',
]

/** 已知的静默命令（可能长时间无输出）*/
const SILENT_COMMANDS = [
  'sleep',
  'read',
  'wait',
  'dd',
  'rsync',
  'scp',
  'wget', 'curl',  // 下载大文件时
  'tar', 'zip', 'unzip', 'gzip',
  'make', 'cmake',
  'gcc', 'g++', 'clang',
  'cargo build', 'go build',
  'mvn', 'gradle',
  'npm install', 'yarn install', 'pnpm install',
]

/** 卡死检测的默认超时（毫秒）*/
const DEFAULT_STUCK_TIMEOUT = 30000

/** 输出追踪的时间窗口（毫秒）*/
const OUTPUT_TRACKING_WINDOW = 10000

export class ProcessMonitor {
  private ptyService?: PtyService
  private terminalStateService?: TerminalStateService
  
  /** 输出追踪器（按终端 ID）*/
  private outputTrackers: Map<string, OutputTracker> = new Map()
  
  /** 卡死超时配置（毫秒）*/
  private stuckTimeout: number = DEFAULT_STUCK_TIMEOUT

  constructor(ptyService?: PtyService, terminalStateService?: TerminalStateService) {
    this.ptyService = ptyService
    this.terminalStateService = terminalStateService
  }

  /**
   * 设置依赖服务
   */
  setServices(ptyService: PtyService, terminalStateService: TerminalStateService): void {
    this.ptyService = ptyService
    this.terminalStateService = terminalStateService
  }

  /**
   * 设置卡死检测超时
   */
  setStuckTimeout(timeout: number): void {
    this.stuckTimeout = timeout
  }

  /**
   * 获取进程状态
   */
  async getProcessState(ptyId: string): Promise<ProcessState> {
    if (!this.ptyService || !this.terminalStateService) {
      return { status: 'idle' }
    }

    const terminalState = this.terminalStateService.getState(ptyId)
    if (!terminalState) {
      return { status: 'idle' }
    }

    // 获取 PTY 级别的状态
    const ptyStatus = await this.ptyService.getTerminalStatus(ptyId)
    
    // 获取输出追踪信息
    const outputTracker = this.outputTrackers.get(ptyId)
    
    // 当前执行的命令
    const currentExecution = terminalState.currentExecution

    // 获取输出速率（在判断空闲前计算）
    const outputRate = this.calculateOutputRate(ptyId)

    // 1. 如果 PTY 报告空闲，需要进一步检查
    if (ptyStatus.isIdle) {
      // 检查是否有持续输出（表示有命令在后台/子进程中运行）
      // 例如 tail -f 会持续输出，但 PTY 可能报告为空闲
      if (outputRate && outputRate > 0.1) {
        // 有持续输出，说明不是真正的空闲
        return {
          status: 'running_streaming',
          outputRate,
          lastOutputTime: outputTracker?.lastOutputTime,
          suggestion: `检测到持续输出，可能有命令正在运行。输出速率: ${outputRate.toFixed(1)} 行/秒`
        }
      }
      
      return {
        status: 'idle',
        suggestion: '终端空闲，可以执行新命令'
      }
    }

    // 2. 有命令正在执行
    const runningTime = currentExecution 
      ? Date.now() - currentExecution.startTime 
      : undefined

    const lastOutputTime = outputTracker?.lastOutputTime
    const timeSinceLastOutput = lastOutputTime 
      ? Date.now() - lastOutputTime 
      : undefined

    // 3. 检测命令类型
    const command = currentExecution?.command || ptyStatus.foregroundProcess || ''
    const commandType = this.classifyCommand(command)

    // 4. 根据命令类型和输出情况判断状态
    let status: ProcessStatus
    let suggestion: string | undefined

    if (commandType === 'interactive') {
      status = 'running_interactive'
      suggestion = `交互式程序 ${ptyStatus.foregroundProcess || command} 正在运行。如需退出，可发送 Ctrl+C 或 q。`
    } else if (commandType === 'streaming') {
      status = 'running_streaming'
      suggestion = `持续输出命令正在运行。输出速率: ${outputRate?.toFixed(1) || 0} 行/秒`
    } else if (commandType === 'silent') {
      // 静默命令，即使没输出也是正常的
      status = 'running_silent'
      suggestion = `命令可能需要较长时间执行，请耐心等待。已运行: ${this.formatDuration(runningTime || 0)}`
    } else {
      // 普通命令，需要检测是否卡死
      const isStuck = this.detectStuck(runningTime, timeSinceLastOutput, outputRate)
      
      if (isStuck) {
        status = 'possibly_stuck'
        suggestion = `命令可能已卡死（${this.formatDuration(timeSinceLastOutput || 0)} 无输出）。建议：1) 使用 get_terminal_context 查看最新输出；2) 如确认卡死，使用 send_control_key 发送 Ctrl+C。`
      } else if (outputRate && outputRate > 0) {
        status = 'running_streaming'
        suggestion = `命令正在执行中，有持续输出。输出速率: ${outputRate.toFixed(1)} 行/秒`
      } else {
        status = 'running_silent'
        suggestion = `命令正在执行中，暂无输出。已运行: ${this.formatDuration(runningTime || 0)}`
      }
    }

    return {
      status,
      foregroundProcess: ptyStatus.foregroundProcess,
      pid: ptyStatus.foregroundPid,
      runningTime,
      lastOutputTime,
      outputRate,
      isKnownLongRunning: commandType === 'silent',
      suggestion
    }
  }

  /**
   * 分类命令类型
   */
  private classifyCommand(command: string): 'interactive' | 'streaming' | 'silent' | 'normal' {
    const cmdLower = command.toLowerCase()

    // 检查交互式命令
    for (const interactive of INTERACTIVE_COMMANDS) {
      if (cmdLower === interactive || cmdLower.startsWith(interactive + ' ') || cmdLower.endsWith('/' + interactive)) {
        return 'interactive'
      }
    }

    // 检查持续输出命令
    for (const streaming of STREAMING_COMMANDS) {
      if (cmdLower.includes(streaming.toLowerCase())) {
        return 'streaming'
      }
    }

    // 检查静默命令
    for (const silent of SILENT_COMMANDS) {
      if (cmdLower.startsWith(silent.toLowerCase()) || cmdLower.includes(' ' + silent.toLowerCase())) {
        return 'silent'
      }
    }

    return 'normal'
  }

  /**
   * 检测命令是否卡死
   */
  private detectStuck(
    runningTime?: number,
    timeSinceLastOutput?: number,
    outputRate?: number
  ): boolean {
    // 如果运行时间不够长，不认为卡死
    if (!runningTime || runningTime < this.stuckTimeout) {
      return false
    }

    // 如果有持续输出，不认为卡死
    if (outputRate && outputRate > 0.1) {
      return false
    }

    // 如果很长时间没有输出，可能卡死
    if (timeSinceLastOutput && timeSinceLastOutput > this.stuckTimeout) {
      return true
    }

    return false
  }

  /**
   * 追踪输出（由外部调用更新）
   */
  trackOutput(ptyId: string, lineCount: number = 1): void {
    let tracker = this.outputTrackers.get(ptyId)
    
    if (!tracker) {
      tracker = {
        recentOutputCounts: [],
        lastOutputTime: Date.now(),
        totalLines: 0
      }
      this.outputTrackers.set(ptyId, tracker)
    }

    const now = Date.now()
    tracker.lastOutputTime = now
    tracker.totalLines += lineCount
    tracker.recentOutputCounts.push({ timestamp: now, lineCount })

    // 清理超出时间窗口的记录
    const cutoff = now - OUTPUT_TRACKING_WINDOW
    tracker.recentOutputCounts = tracker.recentOutputCounts.filter(r => r.timestamp > cutoff)
  }

  /**
   * 计算输出速率（行/秒）
   */
  private calculateOutputRate(ptyId: string): number | undefined {
    const tracker = this.outputTrackers.get(ptyId)
    if (!tracker || tracker.recentOutputCounts.length === 0) {
      return undefined
    }

    const now = Date.now()
    const cutoff = now - OUTPUT_TRACKING_WINDOW
    const recentRecords = tracker.recentOutputCounts.filter(r => r.timestamp > cutoff)

    if (recentRecords.length === 0) {
      return 0
    }

    const totalLines = recentRecords.reduce((sum, r) => sum + r.lineCount, 0)
    const timeSpan = (now - recentRecords[0].timestamp) / 1000 // 转换为秒

    return timeSpan > 0 ? totalLines / timeSpan : totalLines
  }

  /**
   * 格式化时长
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
  }

  /**
   * 清理终端的追踪数据
   */
  clearTracker(ptyId: string): void {
    this.outputTrackers.delete(ptyId)
  }

  /**
   * 判断是否是已知的长时间运行命令
   */
  isKnownLongRunningCommand(command: string): boolean {
    const type = this.classifyCommand(command)
    return type === 'streaming' || type === 'silent' || type === 'interactive'
  }

  /**
   * 获取命令类型的建议超时时间
   */
  getSuggestedTimeout(command: string): number {
    const type = this.classifyCommand(command)
    switch (type) {
      case 'interactive':
        return 0 // 不超时
      case 'streaming':
        return 0 // 不超时
      case 'silent':
        return 300000 // 5 分钟
      default:
        return 30000 // 30 秒
    }
  }
}

// 单例
let processMonitorInstance: ProcessMonitor | null = null

export function getProcessMonitor(): ProcessMonitor {
  if (!processMonitorInstance) {
    processMonitorInstance = new ProcessMonitor()
  }
  return processMonitorInstance
}

export function initProcessMonitor(ptyService: PtyService, terminalStateService: TerminalStateService): ProcessMonitor {
  const monitor = getProcessMonitor()
  monitor.setServices(ptyService, terminalStateService)
  return monitor
}
