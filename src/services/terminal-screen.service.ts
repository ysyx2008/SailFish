/**
 * 终端屏幕内容读取服务
 * 利用 xterm.js Buffer API 读取终端屏幕内容
 * 
 * 增强功能：
 * - InputDetector: 检测输入等待类型（密码、确认、选择等）
 * - OutputRecognizer: 识别输出模式（进度条、测试结果等）
 * - ContextAnalyzer: 分析环境变化（用户、主机、虚拟环境等）
 */
import type { Terminal as XTerm } from '@xterm/xterm'

export interface CursorPosition {
  x: number
  y: number
}

export interface ScreenContent {
  /** 可视区域内容 */
  visibleLines: string[]
  /** 完整缓冲区内容（包含滚动历史） */
  fullBuffer: string[]
  /** 光标位置 */
  cursor: CursorPosition
  /** 终端尺寸 */
  dimensions: {
    cols: number
    rows: number
  }
  /** 缓冲区总行数 */
  totalLines: number
  /** 当前可视区域的起始行（在完整缓冲区中的位置） */
  viewportStartLine: number
}

export interface LineInfo {
  /** 行内容 */
  content: string
  /** 行号（0-based） */
  lineNumber: number
  /** 是否是换行续行 */
  isWrapped: boolean
}

// ==================== 输入等待检测类型 ====================

/** 输入等待类型 */
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
  /** 是否在等待输入 */
  isWaiting: boolean
  /** 等待类型 */
  type: InputWaitingType
  /** 检测到的提示文本 */
  prompt?: string
  /** 可选项（用于 selection 类型）*/
  options?: string[]
  /** 建议的自动响应 */
  suggestedResponse?: string
  /** 置信度 0-1 */
  confidence: number
}

// ==================== 输出模式识别类型 ====================

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
  /** 模式类型 */
  type: OutputPatternType
  /** 置信度 0-1 */
  confidence: number
  /** 详细信息 */
  details?: {
    /** 进度百分比 */
    progress?: number
    /** 通过的测试数 */
    testsPassed?: number
    /** 失败的测试数 */
    testsFailed?: number
    /** 错误数量 */
    errorCount?: number
    /** ETA 预计剩余时间 */
    eta?: string
  }
}

// ==================== 环境分析类型 ====================

/** 环境上下文 */
export interface EnvironmentContext {
  /** 检测到的用户名 */
  user?: string
  /** 检测到的主机名 */
  hostname?: string
  /** 是否是 root 用户 */
  isRoot: boolean
  /** 当前路径（从提示符解析）*/
  cwdFromPrompt?: string
  /** 激活的虚拟环境 */
  activeEnvs: string[]
  /** SSH 深度（检测到的 SSH 跳转层数）*/
  sshDepth: number
  /** 提示符类型 */
  promptType: 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd' | 'unknown'
}

/** 完整的终端感知状态 */
export interface TerminalAwarenessState {
  /** 输入等待状态 */
  input: InputWaitingState
  /** 输出模式 */
  output: OutputPattern
  /** 环境上下文 */
  context: EnvironmentContext
  /** 分析时间戳 */
  timestamp: number
}

/**
 * 终端屏幕服务类
 * 封装 xterm.js Buffer API，提供结构化的屏幕内容读取能力
 */
export class TerminalScreenService {
  private terminal: XTerm

  constructor(terminal: XTerm) {
    this.terminal = terminal
  }

  /**
   * 获取光标位置
   */
  getCursorPosition(): CursorPosition {
    const buffer = this.terminal.buffer.active
    return {
      x: buffer.cursorX,
      y: buffer.cursorY
    }
  }

  /**
   * 获取终端尺寸
   */
  getDimensions(): { cols: number; rows: number } {
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows
    }
  }

  /**
   * 获取指定行的内容
   * @param lineNumber 行号（0-based，相对于缓冲区起始）
   * @param trimRight 是否去除右侧空白
   */
  getLine(lineNumber: number, trimRight: boolean = true): LineInfo | null {
    const buffer = this.terminal.buffer.active
    const line = buffer.getLine(lineNumber)
    
    if (!line) {
      return null
    }

    let content = line.translateToString(trimRight)
    
    return {
      content,
      lineNumber,
      isWrapped: line.isWrapped
    }
  }

  /**
   * 获取当前可视区域内容
   */
  getVisibleContent(): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    
    // 可视区域起始行 = baseY（滚动位置）
    const startLine = buffer.baseY
    const endLine = startLine + this.terminal.rows

    for (let i = startLine; i < endLine; i++) {
      const line = buffer.getLine(i)
      if (line) {
        lines.push(line.translateToString(true))
      } else {
        lines.push('')
      }
    }

    return lines
  }

  /**
   * 获取完整缓冲区内容（包含滚动历史）
   * @param maxLines 最大行数限制，0 表示不限制
   */
  getFullBuffer(maxLines: number = 0): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    const totalLines = buffer.length

    const startLine = maxLines > 0 ? Math.max(0, totalLines - maxLines) : 0

    for (let i = startLine; i < totalLines; i++) {
      const line = buffer.getLine(i)
      if (line) {
        lines.push(line.translateToString(true))
      } else {
        lines.push('')
      }
    }

    return lines
  }

  /**
   * 获取最近 N 行输出
   * @param n 行数
   * @param skipEmpty 是否跳过末尾空行
   */
  getLastNLines(n: number, skipEmpty: boolean = true): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    let totalLines = buffer.length

    // 如果需要跳过末尾空行，先找到最后一个非空行
    if (skipEmpty) {
      while (totalLines > 0) {
        const line = buffer.getLine(totalLines - 1)
        if (line && line.translateToString(true).trim() !== '') {
          break
        }
        totalLines--
      }
    }

    const startLine = Math.max(0, totalLines - n)

    for (let i = startLine; i < totalLines; i++) {
      const line = buffer.getLine(i)
      if (line) {
        lines.push(line.translateToString(true))
      } else {
        lines.push('')
      }
    }

    return lines
  }

  /**
   * 获取完整的屏幕状态
   */
  getScreenContent(): ScreenContent {
    const buffer = this.terminal.buffer.active

    return {
      visibleLines: this.getVisibleContent(),
      fullBuffer: this.getFullBuffer(),
      cursor: this.getCursorPosition(),
      dimensions: this.getDimensions(),
      totalLines: buffer.length,
      viewportStartLine: buffer.baseY
    }
  }

  /**
   * 获取光标所在行的内容
   */
  getCurrentLine(): string {
    const buffer = this.terminal.buffer.active
    const cursorY = buffer.baseY + buffer.cursorY
    const line = buffer.getLine(cursorY)
    return line ? line.translateToString(true) : ''
  }

  /**
   * 获取光标前的内容（当前行）
   */
  getContentBeforeCursor(): string {
    const buffer = this.terminal.buffer.active
    const cursorY = buffer.baseY + buffer.cursorY
    const line = buffer.getLine(cursorY)
    
    if (!line) {
      return ''
    }

    // 获取光标前的内容
    let content = ''
    for (let x = 0; x < buffer.cursorX; x++) {
      const cell = line.getCell(x)
      if (cell) {
        content += cell.getChars() || ' '
      }
    }
    
    return content
  }

  /**
   * 搜索屏幕内容中的特定模式
   * @param pattern 正则表达式
   * @param maxLines 搜索的最大行数（从底部开始）
   */
  searchContent(pattern: RegExp, maxLines: number = 100): Array<{ line: number; content: string; matches: RegExpMatchArray }> {
    const buffer = this.terminal.buffer.active
    const results: Array<{ line: number; content: string; matches: RegExpMatchArray }> = []
    
    const totalLines = buffer.length
    const startLine = Math.max(0, totalLines - maxLines)

    for (let i = startLine; i < totalLines; i++) {
      const line = buffer.getLine(i)
      if (line) {
        const content = line.translateToString(true)
        const matches = content.match(pattern)
        if (matches) {
          results.push({ line: i, content, matches })
        }
      }
    }

    return results
  }

  /**
   * 检测当前是否在命令提示符状态（简单启发式）
   * 通过检查光标所在行是否匹配常见提示符模式
   */
  isAtPrompt(): boolean {
    const currentLine = this.getCurrentLine()
    
    // 常见的 shell 提示符模式
    const promptPatterns = [
      /[$#%>❯➜»⟩›]\s*$/,                    // 常见结束符
      /\w+@[\w.-]+[^$#%]*[$#%]\s*$/,        // user@host 格式
      /\[\w+@[\w.-]+[^\]]*\]\s*[$#%]\s*$/,  // [user@host path]$ 格式
      /\w+\s*[$#%>❯➜»⟩›]\s*$/,             // 简单的 user$ 格式
      /[~\/][\w\/.-]*\s*[$#%>❯]\s*$/,       // 路径 + 提示符
    ]

    return promptPatterns.some(p => p.test(currentLine))
  }

  /**
   * 获取选中的文本
   */
  getSelection(): string {
    return this.terminal.getSelection()
  }

  /**
   * 检测屏幕内容中的错误信息
   * @param maxLines 检查的最大行数
   */
  detectErrors(maxLines: number = 50): Array<{ line: number; content: string; type: string }> {
    const errorPatterns: Array<{ pattern: RegExp; type: string }> = [
      { pattern: /error:/i, type: 'error' },
      { pattern: /错误/i, type: 'error' },
      { pattern: /failed/i, type: 'failed' },
      { pattern: /失败/i, type: 'failed' },
      { pattern: /exception/i, type: 'exception' },
      { pattern: /异常/i, type: 'exception' },
      { pattern: /not found/i, type: 'not_found' },
      { pattern: /找不到/i, type: 'not_found' },
      { pattern: /permission denied/i, type: 'permission' },
      { pattern: /拒绝访问/i, type: 'permission' },
      { pattern: /command not found/i, type: 'command_not_found' },
      { pattern: /无法识别/i, type: 'command_not_found' },
      { pattern: /cannot /i, type: 'cannot' },
      { pattern: /unable to/i, type: 'unable' },
      { pattern: /fatal:/i, type: 'fatal' },
      { pattern: /panic:/i, type: 'panic' },
    ]

    const errors: Array<{ line: number; content: string; type: string }> = []
    const buffer = this.terminal.buffer.active
    const totalLines = buffer.length
    const startLine = Math.max(0, totalLines - maxLines)

    for (let i = startLine; i < totalLines; i++) {
      const line = buffer.getLine(i)
      if (line) {
        const content = line.translateToString(true)
        for (const { pattern, type } of errorPatterns) {
          if (pattern.test(content)) {
            errors.push({ line: i, content, type })
            break // 每行只记录第一个匹配的错误类型
          }
        }
      }
    }

    return errors
  }

  // ==================== 输入等待检测 (InputDetector) ====================

  /**
   * 检测终端是否在等待用户输入，以及等待什么类型的输入
   */
  detectInputWaiting(): InputWaitingState {
    const currentLine = this.getCurrentLine()
    const recentLines = this.getLastNLines(5)
    
    // 默认状态
    const defaultState: InputWaitingState = {
      isWaiting: false,
      type: 'none',
      confidence: 0
    }

    // 1. 检测密码输入
    const passwordResult = this.detectPasswordPrompt(currentLine, recentLines)
    if (passwordResult.isWaiting) return passwordResult

    // 2. 检测确认提示 (y/n)
    const confirmResult = this.detectConfirmationPrompt(currentLine, recentLines)
    if (confirmResult.isWaiting) return confirmResult

    // 3. 检测选择提示
    const selectionResult = this.detectSelectionPrompt(recentLines)
    if (selectionResult.isWaiting) return selectionResult

    // 4. 检测分页器
    const pagerResult = this.detectPager(currentLine)
    if (pagerResult.isWaiting) return pagerResult

    // 5. 检测编辑器模式
    const editorResult = this.detectEditorMode(recentLines)
    if (editorResult.isWaiting) return editorResult

    // 6. 检测其他自定义输入提示
    const customResult = this.detectCustomInputPrompt(currentLine)
    if (customResult.isWaiting) return customResult

    // 7. 检测 Shell 提示符（空闲状态）
    if (this.isAtPrompt()) {
      return {
        isWaiting: true,
        type: 'prompt',
        prompt: currentLine,
        confidence: 0.9
      }
    }

    return defaultState
  }

  /**
   * 检测密码输入提示
   * 
   * 重要改进：不仅检测密码提示的存在，还要判断当前是否真正处于等待密码输入的状态。
   * 如果密码提示之后已经有了其他输出（说明密码已输入），则不应返回等待状态。
   */
  private detectPasswordPrompt(currentLine: string, recentLines: string[]): InputWaitingState {
    const passwordPatterns = [
      /password\s*:/i,
      /密码\s*[:：]/,
      /\[sudo\]\s*password/i,
      /enter\s*passphrase/i,
      /enter\s*password/i,
      /authentication\s*password/i,
      /login\s*password/i,
      /^\s*password\s*$/i,
      // 增强的模式
      /password\s+for\s+\w+/i,        // password for username
      /\w+'s\s*password/i,             // user's password (SSH)
      /SUDO password/i,                // macOS sudo
      /authentication\s*token/i,       // PAM token
      /doas.*password/i,               // doas (OpenBSD)
      /su:\s*password/i,               // su password prompt
      /pkexec.*password/i,             // polkit password
      /unlock.*password/i,             // keyring unlock
      /gpg.*passphrase/i,              // GPG passphrase
      /ssh.*passphrase/i,              // SSH key passphrase
    ]

    // 首先检查当前行（光标所在行）是否是密码提示
    // 如果光标在密码提示行，这是最可靠的等待状态指示
    for (const pattern of passwordPatterns) {
      if (pattern.test(currentLine)) {
        return {
          isWaiting: true,
          type: 'password',
          prompt: currentLine.trim(),
          confidence: 0.95
        }
      }
    }

    // 检查最近几行是否有密码提示
    // 但需要判断密码提示之后是否已经有了其他输出
    const allLines = [...recentLines]
    
    // 从最新到最旧检查
    for (let i = allLines.length - 1; i >= 0; i--) {
      const line = allLines[i]
      let matchedPasswordPrompt = false
      
      for (const pattern of passwordPatterns) {
        if (pattern.test(line)) {
          matchedPasswordPrompt = true
          break
        }
      }
      
      if (matchedPasswordPrompt) {
        // 找到了密码提示，检查之后是否有有效输出
        // 密码提示之后的行
        const linesAfterPrompt = allLines.slice(i + 1)
        
        // 如果密码提示之后有非空行（不只是空白行），说明密码已输入，命令在执行
        const hasOutputAfterPrompt = linesAfterPrompt.some(l => {
          const trimmed = l.trim()
          // 排除空行
          if (!trimmed) return false
          // 排除可能是相同密码提示的重复（密码错误时会再次提示）
          for (const pattern of passwordPatterns) {
            if (pattern.test(l)) return false
          }
          // 排除典型的密码错误提示（这些提示后通常还会再要密码）
          if (/sorry.*try again/i.test(l)) return false
          if (/incorrect password/i.test(l)) return false
          if (/authentication failure/i.test(l)) return false
          return true
        })
        
        if (hasOutputAfterPrompt) {
          // 密码已输入，有后续输出，不是等待状态
          return { isWaiting: false, type: 'none', confidence: 0 }
        }
        
        // 检查当前行（光标行）是否是空的或只有提示符
        // 密码输入时光标通常在密码提示行的末尾
        const currentTrimmed = currentLine.trim()
        
        // 如果当前行是空的，且最近有密码提示，可能正在等待输入
        // 但也可能是密码已输入完成，命令正在执行的短暂空白
        // 需要结合位置判断
        if (!currentTrimmed || this.isAtPrompt()) {
          // 如果已经回到了 shell 提示符，说明命令已完成
          if (this.isAtPrompt()) {
            return { isWaiting: false, type: 'none', confidence: 0 }
          }
        }
        
        // 密码提示还在最近几行，且之后没有有效输出，认为在等待
        return {
          isWaiting: true,
          type: 'password',
          prompt: line.trim(),
          confidence: 0.85  // 稍低的置信度，因为不是在当前行检测到
        }
      }
    }

    return { isWaiting: false, type: 'none', confidence: 0 }
  }

  /**
   * 检测确认提示 (y/n)
   */
  private detectConfirmationPrompt(currentLine: string, recentLines: string[]): InputWaitingState {
    const confirmPatterns = [
      { pattern: /\(y\/n\)/i, default: 'n' },
      { pattern: /\[y\/n\]/i, default: 'n' },
      { pattern: /\[Y\/n\]/i, default: 'y' },
      { pattern: /\[y\/N\]/i, default: 'n' },
      { pattern: /\(yes\/no\)/i, default: 'no' },
      { pattern: /\[yes\/no\]/i, default: 'no' },
      { pattern: /continue\s*\?\s*\[y\/n\]/i, default: 'n' },
      { pattern: /continue\s*\?/i, default: undefined },
      { pattern: /proceed\s*\?/i, default: undefined },
      { pattern: /确认\s*[？?]/i, default: undefined },
      { pattern: /是否继续/i, default: undefined },
      { pattern: /overwrite\s*\?/i, default: undefined },
      { pattern: /覆盖\s*[？?]/i, default: undefined },
      { pattern: /delete\s*\?/i, default: undefined },
      { pattern: /remove\s*\?/i, default: undefined },
    ]

    const linesToCheck = [currentLine, ...recentLines.slice(-2)]
    
    for (const line of linesToCheck) {
      for (const { pattern, default: defaultAnswer } of confirmPatterns) {
        if (pattern.test(line)) {
          return {
            isWaiting: true,
            type: 'confirmation',
            prompt: line.trim(),
            suggestedResponse: defaultAnswer,
            confidence: 0.9
          }
        }
      }
    }

    return { isWaiting: false, type: 'none', confidence: 0 }
  }

  /**
   * 检测选择提示
   * 
   * 注意：selection 类型不再阻止命令执行，交给大模型根据屏幕内容自主判断。
   * 这里只做非常保守的检测，仅作为参考信息，避免误判。
   */
  private detectSelectionPrompt(_recentLines: string[]): InputWaitingState {
    // 禁用自动检测，完全交给大模型根据屏幕内容自主判断
    // 原因：
    // 1. 数字列表（如 "1. xxx 2. xxx"）很容易被误识别为交互式选项
    // 2. 大模型可以看到屏幕内容，能够更准确地判断是否需要选择输入
    // 3. 即使误判也不会阻止命令执行，因为 selection 类型不在阻止列表中
    return { isWaiting: false, type: 'none', confidence: 0 }
  }

  /**
   * 检测分页器 (more/less)
   */
  private detectPager(currentLine: string): InputWaitingState {
    const pagerPatterns = [
      { pattern: /^--More--/, response: ' ' },          // more
      { pattern: /^:\s*$/, response: 'q' },             // less/vim 底部
      { pattern: /^\(END\)/, response: 'q' },           // less 结束
      { pattern: /^~\s*$/, response: 'q' },             // less 空行
      { pattern: /lines?\s*\d+-\d+/i, response: ' ' },  // 显示行号
      { pattern: /--\s*\d+%\s*--/, response: ' ' },     // 百分比
    ]

    for (const { pattern, response } of pagerPatterns) {
      if (pattern.test(currentLine)) {
        return {
          isWaiting: true,
          type: 'pager',
          prompt: currentLine.trim(),
          suggestedResponse: response,
          confidence: 0.9
        }
      }
    }

    return { isWaiting: false, type: 'none', confidence: 0 }
  }

  /**
   * 检测编辑器模式 (vim/nano 等)
   */
  private detectEditorMode(_recentLines: string[]): InputWaitingState {
    const visibleLines = this.getVisibleContent()
    const allContent = visibleLines.join('\n')
    
    // Vim 特征
    const vimPatterns = [
      /-- INSERT --/,
      /-- NORMAL --/,
      /-- VISUAL --/,
      /-- REPLACE --/,
      /^~\s*$/m,  // Vim 空行标记
      /:\w*\s*$/,  // Vim 命令模式
    ]

    // Nano 特征
    const nanoPatterns = [
      /GNU nano/i,
      /\^G Get Help/,
      /\^X Exit/,
    ]

    for (const pattern of vimPatterns) {
      if (pattern.test(allContent)) {
        return {
          isWaiting: true,
          type: 'editor',
          prompt: 'vim',
          suggestedResponse: ':q!',
          confidence: 0.85
        }
      }
    }

    for (const pattern of nanoPatterns) {
      if (pattern.test(allContent)) {
        return {
          isWaiting: true,
          type: 'editor',
          prompt: 'nano',
          suggestedResponse: '^X',
          confidence: 0.85
        }
      }
    }

    return { isWaiting: false, type: 'none', confidence: 0 }
  }

  /**
   * 检测其他自定义输入提示
   */
  private detectCustomInputPrompt(currentLine: string): InputWaitingState {
    const customPatterns = [
      /enter\s+.+\s*:/i,           // Enter something:
      /input\s*:/i,                // Input:
      /输入\s*[:：]/,               // 输入:
      /请输入/,                     // 请输入
      /type\s+.+\s*:/i,            // Type something:
      /provide\s+.+\s*:/i,         // Provide something:
      /specify\s+.+\s*:/i,         // Specify something:
      /name\s*:/i,                 // Name:
      /value\s*:/i,                // Value:
      /path\s*:/i,                 // Path:
      /url\s*:/i,                  // URL:
      /host\s*:/i,                 // Host:
      /port\s*:/i,                 // Port:
      /username\s*:/i,             // Username:
      /email\s*:/i,                // Email:
    ]

    for (const pattern of customPatterns) {
      if (pattern.test(currentLine)) {
        return {
          isWaiting: true,
          type: 'custom_input',
          prompt: currentLine.trim(),
          confidence: 0.7
        }
      }
    }

    return { isWaiting: false, type: 'none', confidence: 0 }
  }

  // ==================== 输出模式识别 (OutputRecognizer) ====================

  /**
   * 识别当前输出的模式类型
   */
  recognizeOutputPattern(): OutputPattern {
    const recentLines = this.getLastNLines(20)
    
    // 1. 检测进度条
    const progressResult = this.detectProgressPattern(recentLines)
    if (progressResult.confidence > 0.7) return progressResult

    // 2. 检测编译输出
    const compilationResult = this.detectCompilationPattern(recentLines)
    if (compilationResult.confidence > 0.7) return compilationResult

    // 3. 检测测试输出
    const testResult = this.detectTestPattern(recentLines)
    if (testResult.confidence > 0.7) return testResult

    // 4. 检测日志流
    const logResult = this.detectLogStreamPattern(recentLines)
    if (logResult.confidence > 0.7) return logResult

    // 5. 检测错误输出
    const errors = this.detectErrors(20)
    if (errors.length > 0) {
      return {
        type: 'error',
        confidence: Math.min(0.5 + errors.length * 0.1, 0.95),
        details: { errorCount: errors.length }
      }
    }

    // 6. 检测表格输出
    const tableResult = this.detectTablePattern(recentLines)
    if (tableResult.confidence > 0.7) return tableResult

    return { type: 'normal', confidence: 0.5 }
  }

  /**
   * 检测进度条模式
   */
  private detectProgressPattern(lines: string[]): OutputPattern {
    const progressPatterns = [
      /\[([=>#\-]+)\s*\]\s*(\d+)%/,           // [=====>    ] 50%
      /(\d+)%\s*\|([█▓▒░#=\-\s]+)\|/,         // 50% |████░░░░|
      /progress[:\s]*(\d+)%/i,                 // Progress: 50%
      /(\d+)\/(\d+)/,                          // 50/100
      /downloading[:\s]*(\d+)%/i,              // Downloading: 50%
      /uploading[:\s]*(\d+)%/i,                // Uploading: 50%
      /eta[:\s]*(\d+[smh]|\d+:\d+)/i,          // ETA: 5m or 5:30
      /(\d+(?:\.\d+)?)\s*[kmg]?b\/s/i,         // 速度显示
    ]

    let maxProgress = 0
    let eta: string | undefined
    let matchCount = 0

    for (const line of lines) {
      for (const pattern of progressPatterns) {
        const match = line.match(pattern)
        if (match) {
          matchCount++
          // 提取进度百分比
          const percentMatch = line.match(/(\d+)%/)
          if (percentMatch) {
            maxProgress = Math.max(maxProgress, parseInt(percentMatch[1]))
          }
          // 提取 ETA
          const etaMatch = line.match(/eta[:\s]*(\d+[smh]|\d+:\d+)/i)
          if (etaMatch) {
            eta = etaMatch[1]
          }
        }
      }
    }

    if (matchCount > 0) {
      return {
        type: 'progress',
        confidence: Math.min(0.6 + matchCount * 0.1, 0.95),
        details: {
          progress: maxProgress || undefined,
          eta
        }
      }
    }

    return { type: 'normal', confidence: 0 }
  }

  /**
   * 检测编译输出模式
   */
  private detectCompilationPattern(lines: string[]): OutputPattern {
    const compilationPatterns = [
      /compiling/i,
      /building/i,
      /bundling/i,
      /linking/i,
      /generating/i,
      /^make\[?\d*\]?:/,
      /gcc|g\+\+|clang/,
      /tsc|typescript/i,
      /webpack|vite|rollup/i,
      /cargo build/i,
      /go build/i,
      /mvn|gradle/i,
    ]

    let matchCount = 0
    for (const line of lines) {
      for (const pattern of compilationPatterns) {
        if (pattern.test(line)) {
          matchCount++
          break
        }
      }
    }

    if (matchCount >= 2) {
      return {
        type: 'compilation',
        confidence: Math.min(0.6 + matchCount * 0.05, 0.9)
      }
    }

    return { type: 'normal', confidence: 0 }
  }

  /**
   * 检测测试输出模式
   */
  private detectTestPattern(lines: string[]): OutputPattern {
    const testPatterns = [
      { pattern: /✓|✔|PASS|passed/i, type: 'pass' },
      { pattern: /✗|✘|FAIL|failed/i, type: 'fail' },
      { pattern: /test.*passed/i, type: 'pass' },
      { pattern: /test.*failed/i, type: 'fail' },
      { pattern: /(\d+)\s*pass(ed|ing)?/i, type: 'pass' },
      { pattern: /(\d+)\s*fail(ed|ing)?/i, type: 'fail' },
      { pattern: /running\s+\d+\s+tests?/i, type: 'info' },
      { pattern: /test\s+result/i, type: 'info' },
      { pattern: /jest|mocha|vitest|pytest|rspec|phpunit/i, type: 'info' },
    ]

    let passed = 0
    let failed = 0
    let matchCount = 0

    for (const line of lines) {
      for (const { pattern, type } of testPatterns) {
        const match = line.match(pattern)
        if (match) {
          matchCount++
          // 尝试提取数量
          const numMatch = line.match(/(\d+)\s*(pass|fail)/i)
          if (numMatch) {
            if (type === 'pass' || numMatch[2].toLowerCase().includes('pass')) {
              passed = Math.max(passed, parseInt(numMatch[1]))
            } else if (type === 'fail' || numMatch[2].toLowerCase().includes('fail')) {
              failed = Math.max(failed, parseInt(numMatch[1]))
            }
          } else if (type === 'pass') {
            passed++
          } else if (type === 'fail') {
            failed++
          }
        }
      }
    }

    if (matchCount >= 2) {
      return {
        type: 'test',
        confidence: Math.min(0.6 + matchCount * 0.05, 0.95),
        details: {
          testsPassed: passed || undefined,
          testsFailed: failed || undefined
        }
      }
    }

    return { type: 'normal', confidence: 0 }
  }

  /**
   * 检测日志流模式
   */
  private detectLogStreamPattern(lines: string[]): OutputPattern {
    // 常见的日志时间戳格式
    const logPatterns = [
      /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/,    // 2024-01-01 12:00:00 或 ISO
      /^\[\d{2}:\d{2}:\d{2}\]/,                       // [12:00:00]
      /^\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/,        // Jan 01 12:00:00
      /^\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}/,      // 01/Jan/2024:12:00:00
      /\[(INFO|DEBUG|WARN|ERROR|FATAL)\]/i,          // [INFO]
      /^\s*(INFO|DEBUG|WARN|ERROR|FATAL)\s*[:|\-]/i, // INFO: or INFO -
    ]

    let matchCount = 0
    for (const line of lines) {
      for (const pattern of logPatterns) {
        if (pattern.test(line)) {
          matchCount++
          break
        }
      }
    }

    // 如果大部分行都匹配日志模式，认为是日志流
    if (matchCount >= lines.length * 0.5 && matchCount >= 3) {
      return {
        type: 'log_stream',
        confidence: Math.min(0.6 + (matchCount / lines.length) * 0.4, 0.95)
      }
    }

    return { type: 'normal', confidence: 0 }
  }

  /**
   * 检测表格输出模式
   */
  private detectTablePattern(lines: string[]): OutputPattern {
    // 检测固定列格式
    const tableIndicators = [
      /^\s*[\|\+][\-\+]+[\|\+]\s*$/,    // +----+----+
      /^\s*\|.+\|.+\|\s*$/,              // | col | col |
      /^[\w\-]+\s{2,}[\w\-]+\s{2,}/,     // 多个空格分隔的列
    ]

    let tableLineCount = 0
    for (const line of lines) {
      for (const pattern of tableIndicators) {
        if (pattern.test(line)) {
          tableLineCount++
          break
        }
      }
    }

    if (tableLineCount >= 3) {
      return {
        type: 'table',
        confidence: Math.min(0.6 + tableLineCount * 0.05, 0.9)
      }
    }

    return { type: 'normal', confidence: 0 }
  }

  // ==================== 环境分析 (ContextAnalyzer) ====================

  /**
   * 分析当前环境上下文
   */
  analyzeEnvironment(): EnvironmentContext {
    const currentLine = this.getCurrentLine()
    const visibleLines = this.getVisibleContent()
    
    // 解析提示符获取用户和主机信息
    // 首先尝试解析当前行
    let promptInfo = this.parsePrompt(currentLine)
    
    // 如果当前行没有获取到完整的 cwd，可能是提示符被换行截断了
    // 尝试合并前一行来解析完整的提示符
    if (!promptInfo.cwd && this.isLikelyWrappedPrompt(currentLine)) {
      const mergedLine = this.getMergedPromptLine()
      if (mergedLine && mergedLine !== currentLine) {
        const mergedPromptInfo = this.parsePrompt(mergedLine)
        // 如果合并后能获取到更多信息，使用合并后的结果
        if (mergedPromptInfo.cwd) {
          promptInfo = mergedPromptInfo
        }
      }
    }
    
    // 检测虚拟环境
    const activeEnvs = this.detectVirtualEnvs(currentLine, visibleLines)
    
    // 检测 SSH 深度
    const sshDepth = this.detectSshDepth(visibleLines)
    
    // 检测提示符类型
    const promptType = this.detectPromptType(currentLine)

    return {
      user: promptInfo.user,
      hostname: promptInfo.hostname,
      isRoot: promptInfo.isRoot,
      cwdFromPrompt: promptInfo.cwd,
      activeEnvs,
      sshDepth,
      promptType
    }
  }
  
  /**
   * 检查当前行是否看起来像被换行截断的提示符后半部分
   */
  private isLikelyWrappedPrompt(line: string): boolean {
    // 如果行以提示符结束符结尾，但没有完整的 user@host 格式
    // 可能是被换行截断了
    const hasPromptEnding = /[$#%>❯]\s*$/.test(line)
    const hasFullPromptPrefix = /^\s*(?:\([^)]+\)\s*)?[\w-]+@[\w.-]+[:\s]/.test(line)
    
    // 如果有提示符结尾但没有完整的开头，可能是被截断的
    return hasPromptEnding && !hasFullPromptPrefix
  }
  
  /**
   * 获取合并后的提示符行（处理换行截断的情况，支持多行）
   */
  private getMergedPromptLine(): string | null {
    const buffer = this.terminal.buffer.active
    const cursorY = buffer.baseY + buffer.cursorY
    
    // 获取当前行
    const currentLineObj = buffer.getLine(cursorY)
    if (!currentLineObj) {
      return null
    }
    
    const currentLine = currentLineObj.translateToString(true)
    
    // 向前查找最多 5 行，寻找包含 user@host 模式的行
    // 然后合并从该行到当前行的所有内容
    const maxLookback = 5
    const lines: string[] = [currentLine]
    
    for (let i = 1; i <= maxLookback && cursorY - i >= 0; i++) {
      const prevLineObj = buffer.getLine(cursorY - i)
      if (!prevLineObj) {
        break
      }
      
      const prevLine = prevLineObj.translateToString(true)
      lines.unshift(prevLine)
      
      // 检查这一行是否包含 user@host 模式的开头
      if (/[\w-]+@[\w.-]+[:\s]/.test(prevLine)) {
        // 找到了提示符的开头，合并所有行
        return lines.join('').trim()
      }
      
      // 如果遇到空行或明显的命令输出行，停止查找
      if (prevLine.trim() === '' || /^\s*[\w\/.-]+\s*$/.test(prevLine)) {
        // 可能是文件名等输出，但继续查找
        // 因为终端可能有多行输出混在一起
      }
    }
    
    return currentLine
  }

  /**
   * 解析提示符信息
   */
  private parsePrompt(line: string): { user?: string; hostname?: string; isRoot: boolean; cwd?: string } {
    // 常见提示符格式：
    // user@hostname:~$
    // [user@hostname path]$
    // user@hostname /path %
    // hostname:path user$
    
    const patterns = [
      // user@hostname:path$ 或 user@hostname:path#
      /^(?:\([^)]+\)\s*)?(\w+)@([\w.-]+)[:\s]([~\/][\w\/.-]*)\s*[$#%>❯]\s*$/,
      // [user@hostname path]$
      /^\[(\w+)@([\w.-]+)\s+([~\/][\w\/.-]*)\]\s*[$#%]\s*$/,
      // user@hostname path $
      /^(\w+)@([\w.-]+)\s+([~\/][\w\/.-]*)\s*[$#%>❯]\s*$/,
      // hostname:path$
      /^([\w.-]+):([~\/][\w\/.-]*)\s*[$#%]\s*$/,
      // 简单的 user$ 或 #
      /^(\w+)\s*[$#%>❯]\s*$/,
    ]

    for (const pattern of patterns) {
      const match = line.match(pattern)
      if (match) {
        if (match.length >= 4) {
          return {
            user: match[1],
            hostname: match[2],
            isRoot: line.includes('#'),
            cwd: match[3]
          }
        } else if (match.length >= 3 && !match[1].includes('.')) {
          // hostname:path 格式
          return {
            hostname: match[1],
            isRoot: line.includes('#'),
            cwd: match[2]
          }
        } else if (match.length >= 2) {
          return {
            user: match[1],
            isRoot: line.includes('#')
          }
        }
      }
    }

    return { isRoot: line.trim().endsWith('#') }
  }

  /**
   * 检测激活的虚拟环境
   */
  private detectVirtualEnvs(currentLine: string, visibleLines: string[]): string[] {
    const envs: string[] = []
    const allContent = [currentLine, ...visibleLines.slice(0, 5)].join('\n')

    // Python 虚拟环境: (venv) 或 (env_name)
    const venvMatch = allContent.match(/\(([a-zA-Z][\w-]*(?:venv|env)?)\)\s*[\w@]/)
    if (venvMatch) {
      envs.push(`python:${venvMatch[1]}`)
    }

    // Conda 环境: (base) 或 (env_name)
    const condaMatch = allContent.match(/\((?:base|[\w-]+)\)/)
    if (condaMatch && !venvMatch) {
      envs.push(`conda:${condaMatch[0].slice(1, -1)}`)
    }

    // Node.js/NVM: 检测 nvm 相关提示
    const nvmMatch = allContent.match(/nvm[:\s]*(v?[\d.]+)/i)
    if (nvmMatch) {
      envs.push(`node:${nvmMatch[1]}`)
    }

    // Ruby/RVM/rbenv
    const rubyMatch = allContent.match(/ruby[:\s]*([\d.]+)/i)
    if (rubyMatch) {
      envs.push(`ruby:${rubyMatch[1]}`)
    }

    return envs
  }

  /**
   * 检测 SSH 跳转深度
   */
  private detectSshDepth(visibleLines: string[]): number {
    // 通过检测嵌套的 SSH 连接提示来判断
    // 简单实现：检查是否有 "Connection to" 或特殊的 SSH 提示
    let depth = 0
    
    for (const line of visibleLines) {
      if (/ssh\s+[\w@.-]+/i.test(line) || /Connection to .+ closed/i.test(line)) {
        depth++
      }
    }

    // 通常不会有太深的嵌套
    return Math.min(depth, 5)
  }

  /**
   * 检测提示符类型
   */
  private detectPromptType(line: string): 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd' | 'unknown' {
    // Zsh 特征
    if (/[❯➜»⟩›]/.test(line)) {
      return 'zsh'
    }
    
    // Fish 特征
    if (/^[\w@.-]+\s+[~\/][\w\/.-]*>/.test(line)) {
      return 'fish'
    }

    // PowerShell 特征
    if (/^PS\s+[A-Z]:\\/.test(line) || /^PS>/.test(line)) {
      return 'powershell'
    }

    // CMD 特征
    if (/^[A-Z]:\\[\w\\]*>/.test(line)) {
      return 'cmd'
    }

    // Bash 特征（默认 Unix shell）
    if (/[$#]\s*$/.test(line)) {
      return 'bash'
    }

    return 'unknown'
  }

  // ==================== 完整感知状态 ====================

  /**
   * 获取完整的终端感知状态
   * 整合输入检测、输出识别、环境分析
   */
  getAwarenessState(): TerminalAwarenessState {
    return {
      input: this.detectInputWaiting(),
      output: this.recognizeOutputPattern(),
      context: this.analyzeEnvironment(),
      timestamp: Date.now()
    }
  }
}

/**
 * 创建终端屏幕服务实例的工厂函数
 */
export function createTerminalScreenService(terminal: XTerm): TerminalScreenService {
  return new TerminalScreenService(terminal)
}
