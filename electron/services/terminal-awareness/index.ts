/**
 * 终端感知服务
 * 整合前端屏幕分析和后端进程监控，提供统一的终端状态感知能力
 * 
 * 架构说明：
 * - xterm.js（前端）是终端状态的唯一真实来源
 * - 本服务通过 IPC 实时从前端获取屏幕分析结果，无缓存
 * - ProcessMonitor 负责本地进程检测、命令分类、卡死检测
 */
import type { PtyService } from '../pty.service'
import type { SshService } from '../ssh.service'
import type { TerminalStateService, TerminalState, CommandExecution } from '../terminal-state.service'
import { ProcessMonitor, getProcessMonitor, initProcessMonitor, type ProcessState, type ProcessStatus } from './process-monitor'
import { getScreenAnalysisFromFrontend, getVisibleContentFromBuffer, type ScreenAnalysis } from '../screen-content.service'

// ==================== 类型定义 ====================

/** 输入等待类型（与前端保持一致）*/
export type InputWaitingType = 
  | 'password'        // 密码输入
  | 'confirmation'    // 确认 (y/n)
  | 'selection'       // 选择 (1/2/3)
  | 'pager'           // 分页器 (more/less)
  | 'prompt'          // Shell 提示符（空闲）
  | 'editor'          // 编辑器模式 (vim/nano)
  | 'custom_input'    // 其他自定义输入
  | 'none'            // 无等待状态

/** 输入等待状态 */
export interface InputWaitingState {
  isWaiting: boolean
  type: InputWaitingType
  prompt?: string
  options?: string[]
  suggestedResponse?: string
  confidence: number
}

/** 输出模式类型 */
export type OutputPatternType = 
  | 'progress'        // 进度条
  | 'compilation'     // 编译输出
  | 'test'            // 测试结果
  | 'log_stream'      // 日志流
  | 'error'           // 错误输出
  | 'table'           // 表格数据
  | 'normal'          // 普通输出

/** 输出模式 */
export interface OutputPattern {
  type: OutputPatternType
  confidence: number
  details?: {
    progress?: number
    testsPassed?: number
    testsFailed?: number
    errorCount?: number
    eta?: string
  }
}

/** 环境上下文 */
export interface EnvironmentContext {
  user?: string
  hostname?: string
  isRoot: boolean
  cwdFromPrompt?: string
  activeEnvs: string[]
  sshDepth: number
  promptType: 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd' | 'unknown'
}

/** 前端屏幕分析结果（通过 IPC 获取）*/
export interface ScreenAnalysisResult {
  input: InputWaitingState
  output: OutputPattern
  context: EnvironmentContext
  /** 当前可视区域内容（按行） */
  visibleContent?: string[]
  timestamp: number
}

/** 综合终端状态 */
export type TerminalOverallStatus = 
  | 'idle'            // 空闲，等待命令
  | 'busy'            // 正在执行命令
  | 'waiting_input'   // 等待用户输入
  | 'stuck'           // 可能卡死

/** 完整的终端感知状态 */
export interface TerminalAwareness {
  /** 综合状态 */
  status: TerminalOverallStatus
  
  /** 输入等待状态 */
  input: InputWaitingState
  
  /** 进程状态 */
  process: ProcessState
  
  /** 环境上下文 */
  context: EnvironmentContext
  
  /** 输出模式 */
  output: OutputPattern
  
  /** 终端基本状态（来自 TerminalStateService）*/
  terminalState?: {
    type: 'local' | 'ssh'
    cwd: string
    lastCommand?: string
    lastExitCode?: number
    isIdle: boolean
  }
  
  /** 当前执行的命令 */
  currentExecution?: CommandExecution
  
  /** Agent 建议 */
  suggestion: string
  
  /** 是否可以执行新命令 */
  canExecuteCommand: boolean
  
  /** 是否需要用户输入 */
  needsUserInput: boolean
  
  /** 分析时间戳 */
  timestamp: number
}

// ==================== 服务实现 ====================

export class TerminalAwarenessService {
  private ptyService?: PtyService
  private sshService?: SshService
  private terminalStateService?: TerminalStateService
  private processMonitor: ProcessMonitor

  constructor(ptyService?: PtyService, terminalStateService?: TerminalStateService, sshService?: SshService) {
    this.ptyService = ptyService
    this.sshService = sshService
    this.terminalStateService = terminalStateService
    this.processMonitor = getProcessMonitor()
    
    if (ptyService && terminalStateService) {
      initProcessMonitor(ptyService, terminalStateService, sshService)
    }
  }

  /**
   * 设置依赖服务
   */
  setServices(ptyService: PtyService, terminalStateService: TerminalStateService, sshService?: SshService): void {
    this.ptyService = ptyService
    this.sshService = sshService
    this.terminalStateService = terminalStateService
    initProcessMonitor(ptyService, terminalStateService, sshService)
  }

  /**
   * 获取终端当前可视区域内容
   * 实时从前端 xterm.js 获取
   */
  async getVisibleContent(ptyId: string): Promise<string[] | null> {
    return getVisibleContentFromBuffer(ptyId, 2000)
  }

  /**
   * 获取完整的终端感知状态
   * 实时从前端 xterm.js 获取屏幕分析结果
   */
  async getAwareness(ptyId: string): Promise<TerminalAwareness> {
    // 1. 获取进程状态（后端）
    const processState = await this.processMonitor.getProcessState(ptyId)

    // 2. 获取终端基本状态
    const terminalState = this.terminalStateService?.getState(ptyId)

    // 3. 实时从前端获取屏幕分析（xterm.js 是唯一真实来源）
    let screenAnalysis: ScreenAnalysisResult | null = null
    try {
      screenAnalysis = await getScreenAnalysisFromFrontend(ptyId, 2000)
    } catch (e) {
      // 实时获取失败，使用默认值（synthesizeAwareness 会处理 null）
      console.warn(`[TerminalAwareness] 获取屏幕分析失败: ${e}`)
    }

    // 4. 综合判断
    const awareness = this.synthesizeAwareness(processState, terminalState, screenAnalysis)

    return awareness
  }

  /**
   * 综合分析，生成最终的感知状态
   */
  private synthesizeAwareness(
    processState: ProcessState,
    terminalState?: TerminalState,
    screenAnalysis?: ScreenAnalysisResult | null
  ): TerminalAwareness {
    const now = Date.now()
    
    // 默认值
    const defaultInput: InputWaitingState = {
      isWaiting: false,
      type: 'none',
      confidence: 0
    }
    
    const defaultOutput: OutputPattern = {
      type: 'normal',
      confidence: 0.5
    }
    
    const defaultContext: EnvironmentContext = {
      isRoot: false,
      activeEnvs: [],
      sshDepth: 0,
      promptType: 'unknown'
    }

    // 使用屏幕分析结果或默认值
    const input = screenAnalysis?.input || defaultInput
    const output = screenAnalysis?.output || defaultOutput
    const context = screenAnalysis?.context || defaultContext

    // 综合判断终端状态
    let status: TerminalOverallStatus
    let suggestion: string
    let canExecuteCommand: boolean
    let needsUserInput: boolean

    // 判断逻辑（优先级从高到低）：
    // 1. 如果前端检测到特殊输入等待（密码、确认等），状态为 waiting_input
    // 2. 如果后端进程状态为 possibly_stuck，状态为 stuck
    // 3. 如果后端进程状态为 idle，状态为 idle
    // 4. 否则状态为 busy（即使前端误判为 prompt 也不影响）

    // 辅助函数：生成输入等待建议
    const getInputWaitingSuggestion = (inputType: string, prompt?: string, suggestedResponse?: string, options?: string[]): string => {
      switch (inputType) {
        case 'password':
          return `终端正在等待密码输入。提示: "${prompt || 'Password:'}"。请让用户输入密码，或发送 Ctrl+C 取消。`
        case 'confirmation':
          return `终端正在等待确认。提示: "${prompt || '(y/n)'}"。${suggestedResponse ? `建议响应: ${suggestedResponse}` : '请选择 y 或 n。'}`
        case 'selection':
          return `终端正在等待选择。${options?.length ? `可选项: ${options.join(', ')}` : '请输入选项编号。'}`
        case 'pager':
          return `终端处于分页器模式。按 q 退出，空格翻页，Enter 下一行。`
        case 'editor':
          return `终端处于编辑器模式 (${prompt || 'vim/nano'})。请使用 write_file 工具代替编辑器操作，或发送退出命令。`
        case 'custom_input':
          return `终端正在等待输入。提示: "${prompt || 'Input:'}"。`
        default:
          return '终端正在等待用户输入。'
      }
    }

    // 是否是SSH终端
    const isSshTerminal = terminalState?.type === 'ssh'

    if (isSshTerminal) {
      // SSH 终端：状态完全交给模型根据屏幕内容判断
      // 无法通过 pgrep 检测远程进程状态，所以不限制命令执行
      // 模型应根据屏幕上是否显示提示符来判断终端是否空闲
      status = 'idle'
      needsUserInput = false
      canExecuteCommand = true
      suggestion = 'SSH 终端状态请根据屏幕内容判断'
    } else {
      // 本地终端：基于 pgrep 进程检测，状态准确
      
      // 检查是否有特殊输入等待（不是普通 prompt）
      const hasSpecialInputWaiting = input.isWaiting && input.type !== 'prompt' && input.type !== 'none'

      if (hasSpecialInputWaiting) {
        // 最高优先级：前端检测到等待输入（密码、确认、选择等）
        status = 'waiting_input'
        needsUserInput = true
        canExecuteCommand = false
        suggestion = getInputWaitingSuggestion(input.type, input.prompt, input.suggestedResponse, input.options)
      } else if (processState.status === 'possibly_stuck') {
        // 进程可能卡死
        status = 'stuck'
        needsUserInput = false
        canExecuteCommand = false
        suggestion = processState.suggestion || '命令可能已卡死。建议使用 send_control_key 发送 Ctrl+C 中断。'
      } else if (processState.status === 'idle') {
        // 后端认为空闲 = 真正的空闲
        status = 'idle'
        needsUserInput = false
        canExecuteCommand = true
        suggestion = '终端空闲，可以执行新命令。'
      } else {
        // 后端认为进程在运行
        status = 'busy'
        needsUserInput = false
        canExecuteCommand = false
        suggestion = processState.suggestion || '命令正在执行中，请等待完成。'
        
        // 如果有进度信息，添加到建议中
        if (output.type === 'progress' && output.details?.progress !== undefined) {
          suggestion += ` 进度: ${output.details.progress}%`
        }
      }
    }

    return {
      status,
      input,
      process: processState,
      context,
      output,
      terminalState: terminalState ? {
        type: terminalState.type === 'ssh' ? 'ssh' : 'local',
        cwd: terminalState.cwd,
        lastCommand: terminalState.lastCommand,
        lastExitCode: terminalState.lastExitCode,
        isIdle: terminalState.isIdle
      } : undefined,
      currentExecution: terminalState?.currentExecution,
      suggestion,
      canExecuteCommand,
      needsUserInput,
      timestamp: now
    }
  }

  /**
   * 追踪输出（传递给 ProcessMonitor）
   * @param ptyId 终端 ID
   * @param lineCount 行数（可选，默认为 1）
   * @param dataSize 数据大小（字节，可选）- 用于追踪非换行输出如 curl 进度条
   */
  trackOutput(ptyId: string, lineCount: number = 1, dataSize?: number): void {
    this.processMonitor.trackOutput(ptyId, lineCount, dataSize)
  }

  /**
   * 清理终端数据
   */
  clearTerminal(ptyId: string): void {
    this.processMonitor.clearTracker(ptyId)
  }

  /**
   * 快速检查是否可以执行命令
   */
  async canExecute(ptyId: string): Promise<boolean> {
    const awareness = await this.getAwareness(ptyId)
    return awareness.canExecuteCommand
  }

  /**
   * 获取执行命令前的建议
   */
  async getPreExecutionAdvice(ptyId: string, command: string): Promise<{
    canExecute: boolean
    reason?: string
    suggestion?: string
  }> {
    const awareness = await this.getAwareness(ptyId)
    
    if (!awareness.canExecuteCommand) {
      return {
        canExecute: false,
        reason: awareness.status === 'waiting_input' 
          ? '终端正在等待输入' 
          : awareness.status === 'stuck'
          ? '终端可能已卡死'
          : '终端正在执行命令',
        suggestion: awareness.suggestion
      }
    }

    // 检查命令类型，给出建议
    if (this.processMonitor.isKnownLongRunningCommand(command)) {
      const timeout = this.processMonitor.getSuggestedTimeout(command)
      return {
        canExecute: true,
        suggestion: timeout === 0 
          ? `这是一个持续运行的命令，不会自动超时。执行后可能需要手动中断。`
          : `这个命令可能需要较长时间执行（建议超时: ${timeout / 1000}秒）。`
      }
    }

    return { canExecute: true }
  }
}

// ==================== 单例管理 ====================

let awarenessServiceInstance: TerminalAwarenessService | null = null

export function getTerminalAwarenessService(): TerminalAwarenessService {
  if (!awarenessServiceInstance) {
    awarenessServiceInstance = new TerminalAwarenessService()
  }
  return awarenessServiceInstance
}

export function initTerminalAwarenessService(
  ptyService: PtyService, 
  terminalStateService: TerminalStateService,
  sshService?: SshService
): TerminalAwarenessService {
  const service = getTerminalAwarenessService()
  service.setServices(ptyService, terminalStateService, sshService)
  return service
}

// 导出子模块
export { ProcessMonitor, getProcessMonitor, initProcessMonitor } from './process-monitor'
export type { ProcessState, ProcessStatus } from './process-monitor'
