/**
 * 进程状态监控器
 * 负责检测命令执行状态、卡死检测、输出速率分析等
 */
import type { PtyService } from '../pty.service'
import type { SshService } from '../ssh.service'
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
  /** 最近 N 秒的数据包记录（用于追踪非换行输出，如 curl 进度条） */
  recentDataChunks: { timestamp: number; size: number }[]
  /** 最后一次输出时间 */
  lastOutputTime: number
  /** 总输出行数 */
  totalLines: number
  /** 总数据量（字节） */
  totalBytes: number
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
  // 等待/睡眠
  'sleep',
  'read',
  'wait',
  
  // Git 网络操作（克隆/拉取/推送可能较慢，且进度输出使用 \r 覆盖）
  'git clone', 'git pull', 'git push', 'git fetch',
  'git submodule update', 'git lfs pull', 'git lfs fetch',
  
  // 文件传输
  'dd',
  'rsync',
  'scp', 'sftp',
  'wget', 'curl',  // 下载大文件时
  'ftp',
  
  // 压缩解压
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  'bzip2', 'bunzip2', 'xz', 'unxz',
  '7z', 'rar', 'unrar',
  
  // C/C++ 编译
  'make', 'cmake', 'ninja',
  'gcc', 'g++', 'clang', 'clang++',
  'cc', 'c++',
  
  // Rust
  'cargo build', 'cargo test', 'cargo run',
  'cargo check', 'cargo clippy',
  'rustc',
  
  // Go
  'go build', 'go test', 'go run',
  'go install', 'go mod',
  
  // Java/JVM
  'mvn', 'mvn compile', 'mvn package', 'mvn install', 'mvn test',
  'gradle', 'gradle build', 'gradle test', 'gradle assemble',
  'javac', 'java -jar',
  'ant',
  
  // Node.js/JavaScript
  'npm install', 'npm ci', 'npm run build', 'npm run test',
  'npm run compile', 'npm run dist', 'npm run bundle',
  'yarn install', 'yarn build', 'yarn test',
  'pnpm install', 'pnpm build', 'pnpm test',
  'npx', 'bunx',
  'bun install', 'bun build', 'bun test',
  'webpack', 'rollup', 'vite build', 'esbuild',
  'tsc', 'tsc --build',
  
  // Python
  'pip install', 'pip3 install',
  'python setup.py', 'python3 setup.py',
  'pytest', 'python -m pytest',
  'poetry install', 'poetry build',
  'pdm install', 'pdm build',
  
  // Ruby
  'bundle install', 'bundle exec',
  'gem install',
  'rake',
  
  // .NET
  'dotnet build', 'dotnet publish', 'dotnet test',
  'dotnet restore', 'dotnet run',
  'msbuild',
  
  // iOS/macOS
  'xcodebuild',
  'swift build', 'swift test',
  'pod install',
  
  // Android
  './gradlew', 'gradlew.bat',
  
  // Docker
  'docker build', 'docker-compose build',
  'docker pull', 'docker push',
  
  // 其他构建工具
  'bazel build', 'bazel test',
  'buck build',
  'pants',
  'scons',
]

/** 卡死检测的默认超时（毫秒）*/
const DEFAULT_STUCK_TIMEOUT = 30000

/** 输出追踪的时间窗口（毫秒）*/
const OUTPUT_TRACKING_WINDOW = 10000

export class ProcessMonitor {
  private ptyService?: PtyService
  private sshService?: SshService
  private terminalStateService?: TerminalStateService
  
  /** 输出追踪器（按终端 ID）*/
  private outputTrackers: Map<string, OutputTracker> = new Map()
  
  /** 卡死超时配置（毫秒）*/
  private stuckTimeout: number = DEFAULT_STUCK_TIMEOUT

  constructor(ptyService?: PtyService, terminalStateService?: TerminalStateService, sshService?: SshService) {
    this.ptyService = ptyService
    this.terminalStateService = terminalStateService
    this.sshService = sshService
  }

  /**
   * 设置依赖服务
   */
  setServices(ptyService: PtyService, terminalStateService: TerminalStateService, sshService?: SshService): void {
    this.ptyService = ptyService
    this.terminalStateService = terminalStateService
    if (sshService) {
      this.sshService = sshService
    }
  }

  /**
   * 设置 SSH 服务
   */
  setSshService(sshService: SshService): void {
    this.sshService = sshService
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

    // 对于 SSH 终端，无法通过本地进程检测状态
    // 需要依赖 terminalState.isIdle（由提示符检测等机制更新）
    if (terminalState.type === 'ssh') {
      return this.getProcessStateForSsh(terminalState, ptyId)
    }

    // 获取 PTY 级别的状态（仅适用于本地终端）
    const ptyStatus = await this.ptyService.getTerminalStatus(ptyId)
    
    // 获取输出追踪信息
    const outputTracker = this.outputTrackers.get(ptyId)
    
    // 当前执行的命令
    const currentExecution = terminalState.currentExecution

    // 获取输出速率（在判断空闲前计算）
    const outputRate = this.calculateOutputRate(ptyId)
    const dataRate = this.calculateDataRate(ptyId)
    const hasActivity = this.hasActiveOutput(ptyId)

    // 1. 如果 PTY 报告空闲，需要进一步检查
    if (ptyStatus.isIdle) {
      // 检查是否有持续输出（表示有命令在后台/子进程中运行）
      // 例如 tail -f 会持续输出，curl 进度条也会持续输出数据
      if (hasActivity) {
        // 有持续输出，说明不是真正的空闲
        return {
          status: 'running_streaming',
          outputRate,
          lastOutputTime: outputTracker?.lastOutputTime,
          suggestion: `检测到持续输出，可能有命令正在运行。${dataRate ? `数据速率: ${(dataRate / 1024).toFixed(1)} KB/秒` : `输出速率: ${outputRate?.toFixed(1) || 0} 行/秒`}`
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
   * 获取 SSH 终端的进程状态（增强版）
   * 优先使用 exec channel 获取远程进程状态，回退到输出分析
   */
  private async getProcessStateForSsh(terminalState: TerminalState, ptyId: string): Promise<ProcessState> {
    // 获取输出追踪信息
    const outputTracker = this.outputTrackers.get(ptyId)
    const outputRate = this.calculateOutputRate(ptyId)
    const dataRate = this.calculateDataRate(ptyId)
    const lastOutputTime = outputTracker?.lastOutputTime
    const hasActivity = this.hasActiveOutput(ptyId)

    // 当前执行的命令
    const currentExecution = terminalState.currentExecution
    const runningTime = currentExecution 
      ? Date.now() - currentExecution.startTime 
      : undefined

    const timeSinceLastOutput = lastOutputTime 
      ? Date.now() - lastOutputTime 
      : undefined

    // **重要**: 首先检查是否有持续输出（适用于 curl 进度条等非换行输出）
    // 这比 exec channel 检测更可靠，因为 exec channel 的 $$ 不是终端 shell 的 PID
    if (hasActivity) {
      // 有活动输出，说明命令正在执行
      const command = currentExecution?.command || terminalState.lastCommand || ''
      const commandType = this.classifyCommand(command)
      
      return {
        status: commandType === 'interactive' ? 'running_interactive' : 'running_streaming',
        foregroundProcess: command ? command.split(' ')[0] : undefined,
        runningTime,
        lastOutputTime,
        outputRate,
        suggestion: `SSH 终端检测到持续数据输出，命令正在运行。${dataRate ? `数据速率: ${(dataRate / 1024).toFixed(1)} KB/秒` : ''}`
      }
    }

    // 尝试使用 SSH exec channel 获取远程进程状态（作为补充检测）
    let execChannelDetectedIdle = false
    if (this.sshService) {
      try {
        const remoteProcesses = await this.sshService.getRemoteProcesses(ptyId)
        if (remoteProcesses && remoteProcesses.children.length > 0) {
          // 有子进程在运行，说明有命令正在执行
          const child = remoteProcesses.children[0]
          const commandType = this.classifyCommand(child.comm)
          
          if (commandType === 'interactive') {
            return {
              status: 'running_interactive',
              foregroundProcess: child.comm,
              pid: child.pid,
              runningTime,
              lastOutputTime,
              outputRate,
              suggestion: `SSH 终端: 交互式程序 ${child.comm} 正在运行（通过 exec channel 检测）。如需退出，可发送 Ctrl+C 或 q。`
            }
          }
          
          return {
            status: outputRate && outputRate > 0.1 ? 'running_streaming' : 'running_silent',
            foregroundProcess: child.comm,
            pid: child.pid,
            runningTime,
            lastOutputTime,
            outputRate,
            suggestion: `SSH 终端: 进程 ${child.comm} (PID: ${child.pid}) 正在运行。${outputRate ? `输出速率: ${outputRate.toFixed(1)} 行/秒` : ''}`
          }
        } else {
          // exec channel 检测到没有子进程运行，标记为空闲
          execChannelDetectedIdle = true
        }
      } catch (err) {
        // exec channel 失败，继续使用传统检测
        console.log(`[ProcessMonitor] SSH exec channel 检测失败，回退到传统方式: ${err}`)
      }
    }

    // 回退方案：基于 terminalState 和输出分析
    // SSH 终端状态判断优先级：
    // 1. 如果有持续输出，认为正在执行命令（已在上面处理）
    // 2. 如果 terminalState.isIdle 为 true（由提示符检测更新），认为空闲
    // 3. 如果 exec channel 检测没有子进程且无输出活动，认为空闲
    // 4. 如果有当前执行的命令且运行时间较长无输出，可能卡死
    // 5. 否则认为正在执行命令

    // **关键修复**: 当检测到终端空闲时，即使 currentExecution 存在也应返回空闲
    // 这修复了长耗时命令（如 curl）超时后 currentExecution 未被清理的问题
    const detectedIdle = terminalState.isIdle || execChannelDetectedIdle
    
    if (detectedIdle && !hasActivity) {
      // 终端空闲（通过提示符检测或 exec channel 确认），且无持续输出
      // 如果存在未清理的 currentExecution，自动清理它
      if (currentExecution && this.terminalStateService) {
        console.log(`[ProcessMonitor] SSH 终端检测到空闲，自动完成未清理的命令执行: ${currentExecution.command}`)
        this.terminalStateService.completeCommandExecution(ptyId, 0, 'completed')
      }
      return {
        status: 'idle',
        suggestion: 'SSH 终端空闲，可以执行新命令'
      }
    }

    // 有命令正在执行或终端非空闲
    const command = currentExecution?.command || terminalState.lastCommand || ''
    const commandType = this.classifyCommand(command)

    let status: ProcessStatus
    let suggestion: string | undefined

    if (commandType === 'interactive') {
      status = 'running_interactive'
      suggestion = `SSH 终端: 交互式程序 ${command} 正在运行。如需退出，可发送 Ctrl+C 或 q。`
    } else if (commandType === 'streaming' || (outputRate && outputRate > 0.5)) {
      status = 'running_streaming'
      suggestion = `SSH 终端: 持续输出命令正在运行。输出速率: ${outputRate?.toFixed(1) || 0} 行/秒`
    } else if (commandType === 'silent') {
      status = 'running_silent'
      suggestion = `SSH 终端: 命令可能需要较长时间执行，请耐心等待。${runningTime ? `已运行: ${this.formatDuration(runningTime)}` : ''}`
    } else {
      // 普通命令，需要检测是否卡死
      const isStuck = this.detectStuck(runningTime, timeSinceLastOutput, outputRate)
      
      if (isStuck) {
        status = 'possibly_stuck'
        suggestion = `SSH 终端: 命令可能已卡死（${this.formatDuration(timeSinceLastOutput || 0)} 无输出）。建议：1) 使用 get_terminal_context 查看最新输出；2) 如确认卡死，使用 send_control_key 发送 Ctrl+C。`
      } else if (outputRate && outputRate > 0) {
        status = 'running_streaming'
        suggestion = `SSH 终端: 命令正在执行中，有持续输出。输出速率: ${outputRate.toFixed(1)} 行/秒`
      } else {
        status = 'running_silent'
        suggestion = `SSH 终端: 命令正在执行中，暂无输出。${runningTime ? `已运行: ${this.formatDuration(runningTime)}` : ''}`
      }
    }

    return {
      status,
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
   * @param ptyId 终端 ID
   * @param lineCount 行数（可选，默认为 1）
   * @param dataSize 数据大小（字节，可选）- 用于追踪非换行输出如 curl 进度条
   */
  trackOutput(ptyId: string, lineCount: number = 1, dataSize?: number): void {
    let tracker = this.outputTrackers.get(ptyId)
    
    if (!tracker) {
      tracker = {
        recentOutputCounts: [],
        recentDataChunks: [],
        lastOutputTime: Date.now(),
        totalLines: 0,
        totalBytes: 0
      }
      this.outputTrackers.set(ptyId, tracker)
    }

    const now = Date.now()
    tracker.lastOutputTime = now
    tracker.totalLines += lineCount
    tracker.recentOutputCounts.push({ timestamp: now, lineCount })

    // 追踪数据包（用于检测 curl 进度条等非换行输出）
    if (dataSize !== undefined && dataSize > 0) {
      tracker.totalBytes += dataSize
      tracker.recentDataChunks.push({ timestamp: now, size: dataSize })
    }

    // 清理超出时间窗口的记录
    const cutoff = now - OUTPUT_TRACKING_WINDOW
    tracker.recentOutputCounts = tracker.recentOutputCounts.filter(r => r.timestamp > cutoff)
    tracker.recentDataChunks = tracker.recentDataChunks.filter(r => r.timestamp > cutoff)
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
   * 检查是否有持续数据输出（用于检测 curl 进度条等非换行输出）
   * 返回数据流速率（字节/秒）或 undefined
   */
  private calculateDataRate(ptyId: string): number | undefined {
    const tracker = this.outputTrackers.get(ptyId)
    if (!tracker || tracker.recentDataChunks.length === 0) {
      return undefined
    }

    const now = Date.now()
    const cutoff = now - OUTPUT_TRACKING_WINDOW
    const recentChunks = tracker.recentDataChunks.filter(r => r.timestamp > cutoff)

    if (recentChunks.length === 0) {
      return 0
    }

    const totalBytes = recentChunks.reduce((sum, r) => sum + r.size, 0)
    const timeSpan = (now - recentChunks[0].timestamp) / 1000 // 转换为秒

    return timeSpan > 0 ? totalBytes / timeSpan : totalBytes
  }

  /**
   * 检查终端是否有活动输出（综合行数和数据量）
   * 用于判断如 curl 下载进度这样的命令是否在运行
   */
  private hasActiveOutput(ptyId: string): boolean {
    const tracker = this.outputTrackers.get(ptyId)
    if (!tracker) return false

    const now = Date.now()
    // 如果最后输出时间在 3 秒内，认为有活动
    if (now - tracker.lastOutputTime < 3000) {
      return true
    }

    // 检查输出速率
    const outputRate = this.calculateOutputRate(ptyId)
    if (outputRate && outputRate > 0.1) return true

    // 检查数据流速率（用于 curl 进度条等）
    const dataRate = this.calculateDataRate(ptyId)
    if (dataRate && dataRate > 10) return true  // 超过 10 字节/秒认为有活动

    return false
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

export function initProcessMonitor(ptyService: PtyService, terminalStateService: TerminalStateService, sshService?: SshService): ProcessMonitor {
  const monitor = getProcessMonitor()
  monitor.setServices(ptyService, terminalStateService, sshService)
  return monitor
}
