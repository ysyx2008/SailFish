/**
 * 终端屏幕内容读取服务
 * 利用 xterm.js Buffer API 读取终端屏幕内容
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
}

/**
 * 创建终端屏幕服务实例的工厂函数
 */
export function createTerminalScreenService(terminal: XTerm): TerminalScreenService {
  return new TerminalScreenService(terminal)
}
