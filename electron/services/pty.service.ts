import * as pty from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import * as os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import stripAnsi from 'strip-ansi'

const execAsync = promisify(exec)

export interface PtyOptions {
  cols?: number
  rows?: number
  cwd?: string
  shell?: string
  env?: Record<string, string>
}

export interface CommandResult {
  output: string
  exitCode: number
  duration: number
  aborted?: boolean
}

interface PtyInstance {
  pty: pty.IPty
  dataCallbacks: ((data: string) => void)[]
  disposed: boolean
}

// 用于追踪正在执行的命令
interface PendingCommand {
  markerId: string
  resolve: (result: CommandResult) => void
  reject: (error: Error) => void
  startTime: number
  output: string
  collecting: boolean
  timeoutId?: NodeJS.Timeout
}

export class PtyService {
  private instances: Map<string, PtyInstance> = new Map()
  // 追踪正在执行的命令（按 ptyId 分组）
  private pendingCommands: Map<string, PendingCommand> = new Map()
  // 调试用：上次输出提示符检测日志的时间
  private lastPromptLog: number = 0

  // 标记前缀，使用特殊 Unicode 字符降低冲突概率
  private readonly MARKER_PREFIX = '⟦AGENT:'
  private readonly MARKER_SUFFIX = '⟧'

  /**
   * 获取默认 Shell
   */
  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/bash'
  }

  /**
   * 创建新的 PTY 实例
   */
  create(options: PtyOptions = {}): string {
    const id = uuidv4()

    const shell = options.shell || this.getDefaultShell()
    const cwd = options.cwd || os.homedir()
    const cols = options.cols || 80
    const rows = options.rows || 24

    // 合并环境变量
    const env = {
      ...process.env,
      ...options.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // macOS: 让 ls 等命令显示颜色
      CLICOLOR: '1',
      CLICOLOR_FORCE: '1',
      // Linux: 让 ls 等命令显示颜色
      LS_COLORS: process.env.LS_COLORS || 'di=1;34:ln=1;36:so=1;35:pi=33:ex=1;32:bd=1;33:cd=1;33:su=1;31:sg=1;31:tw=1;34:ow=1;34'
    } as Record<string, string>

    // 创建 PTY
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })

    const instance: PtyInstance = {
      pty: ptyProcess,
      dataCallbacks: [],
      disposed: false
    }

    // 监听数据输出
    ptyProcess.onData((data: string) => {
      // 如果已销毁，不再触发回调
      if (instance.disposed) return
      instance.dataCallbacks.forEach(callback => {
        try {
          callback(data)
        } catch (e) {
          // 忽略回调错误（如 EPIPE）
        }
      })
    })

    // 监听退出
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`PTY ${id} exited with code ${exitCode}`)
      this.instances.delete(id)
    })

    this.instances.set(id, instance)
    return id
  }

  /**
   * 向 PTY 写入数据
   */
  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.pty.write(data)
    }
  }

  /**
   * 调整 PTY 大小
   */
  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.pty.resize(cols, rows)
    }
  }

  /**
   * 注册数据回调
   * @returns 取消监听的函数
   */
  onData(id: string, callback: (data: string) => void): () => void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.dataCallbacks.push(callback)
    }
    // 返回取消监听的函数
    return () => {
      const inst = this.instances.get(id)
      if (inst) {
        const index = inst.dataCallbacks.indexOf(callback)
        if (index !== -1) {
          inst.dataCallbacks.splice(index, 1)
        }
      }
    }
  }

  /**
   * 销毁 PTY 实例
   */
  dispose(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      // 标记为已销毁，防止后续回调触发
      instance.disposed = true
      instance.dataCallbacks = []
      try {
        instance.pty.kill()
      } catch (e) {
        // 忽略 kill 时的错误
      }
      this.instances.delete(id)
    }
  }

  /**
   * 销毁所有 PTY 实例
   */
  disposeAll(): void {
    this.instances.forEach((instance, id) => {
      instance.disposed = true
      instance.dataCallbacks = []
      try {
        instance.pty.kill()
      } catch (e) {
        // 忽略 kill 时的错误
      }
      this.instances.delete(id)
    })
    // 清理所有待执行命令
    this.pendingCommands.forEach((cmd) => {
      if (cmd.timeoutId) clearTimeout(cmd.timeoutId)
      cmd.reject(new Error('PTY disposed'))
    })
    this.pendingCommands.clear()
  }

  /**
   * 检查 PTY 实例是否存在
   */
  hasInstance(id: string): boolean {
    return this.instances.has(id)
  }

  /**
   * 生成唯一标记 ID
   */
  private generateMarkerId(): string {
    return Math.random().toString(36).substring(2, 10)
  }

  /**
   * 构建带标记的命令
   * 使用不可见的方式添加标记：
   * 1. 先执行实际命令（用户看到的）
   * 2. 使用 ANSI 转义序列隐藏标记输出
   */
  private buildWrappedCommand(command: string, markerId: string): string {
    const startMarker = `${this.MARKER_PREFIX}S:${markerId}${this.MARKER_SUFFIX}`
    const endMarker = `${this.MARKER_PREFIX}E:${markerId}`
    
    // 使用 ANSI 隐藏序列：\x1b[8m 隐藏文本，\x1b[28m 取消隐藏
    // 或者使用极暗的颜色 \x1b[2m (dim) + \x1b[30m (black)
    const hide = '\\x1b[2m\\x1b[30m'
    const show = '\\x1b[0m'
    
    if (process.platform === 'win32') {
      // PowerShell - 暂时保持原样
      return `echo '${startMarker}'; ${command}; echo '${endMarker}:'$LASTEXITCODE'${this.MARKER_SUFFIX}'\r`
    } else {
      // Bash/Zsh - 使用 printf 输出隐藏的标记
      // 先输出隐藏的开始标记，然后执行命令，最后输出隐藏的结束标记
      return `printf '${hide}${startMarker}${show}\\n' && ${command}; printf '${hide}${endMarker}:'$?'${this.MARKER_SUFFIX}${show}\\n'\n`
    }
  }

  /**
   * 在当前终端会话中执行命令并等待结果
   * @param id PTY 实例 ID
   * @param command 要执行的命令
   * @param timeout 超时时间（毫秒），默认 30000
   */
  executeCommand(id: string, command: string, timeout: number = 30000): Promise<CommandResult> {
    const instance = this.instances.get(id)
    if (!instance) {
      return Promise.reject(new Error(`PTY instance ${id} not found`))
    }

    const markerId = this.generateMarkerId()
    const wrappedCommand = this.buildWrappedCommand(command, markerId)
    const startTime = Date.now()

    return new Promise((resolve, reject) => {
      // 创建待执行命令记录
      const pendingCmd: PendingCommand = {
        markerId,
        resolve,
        reject,
        startTime,
        output: '',
        collecting: false
      }

      // 设置超时
      pendingCmd.timeoutId = setTimeout(() => {
        this.pendingCommands.delete(id)
        resolve({
          output: pendingCmd.output,
          exitCode: -1,
          duration: Date.now() - startTime,
          aborted: true
        })
      }, timeout)

      // 注册命令
      this.pendingCommands.set(id, pendingCmd)

      // 注册输出处理器
      const outputHandler = (data: string) => {
        this.handleCommandOutput(id, data)
      }
      
      // 添加临时回调用于处理命令输出
      instance.dataCallbacks.push(outputHandler)

      // 发送命令
      instance.pty.write(wrappedCommand)
    })
  }

  /**
   * 处理命令输出，检测标记并收集输出
   */
  private handleCommandOutput(ptyId: string, data: string): void {
    const pendingCmd = this.pendingCommands.get(ptyId)
    if (!pendingCmd) return

    const startPattern = `${this.MARKER_PREFIX}S:${pendingCmd.markerId}${this.MARKER_SUFFIX}`
    const endPattern = new RegExp(
      `${this.escapeRegExp(this.MARKER_PREFIX)}E:${pendingCmd.markerId}:(\\d+)${this.escapeRegExp(this.MARKER_SUFFIX)}`
    )

    // 累积数据
    pendingCmd.output += data

    // 检查是否开始收集
    if (!pendingCmd.collecting) {
      const startIdx = pendingCmd.output.indexOf(startPattern)
      if (startIdx !== -1) {
        pendingCmd.collecting = true
        // 移除开始标记之前的内容（包括标记本身）
        pendingCmd.output = pendingCmd.output.substring(startIdx + startPattern.length)
      }
    }

    // 检查是否结束
    if (pendingCmd.collecting) {
      const match = pendingCmd.output.match(endPattern)
      if (match) {
        const exitCode = parseInt(match[1], 10)
        // 移除结束标记及其后的内容
        const endIdx = pendingCmd.output.indexOf(match[0])
        const output = pendingCmd.output.substring(0, endIdx)

        // 清理
        if (pendingCmd.timeoutId) {
          clearTimeout(pendingCmd.timeoutId)
        }
        this.pendingCommands.delete(ptyId)

        // 清理输出中的换行符和多余空白
        const cleanOutput = this.cleanOutput(output)

        // 返回结果
        pendingCmd.resolve({
          output: cleanOutput,
          exitCode,
          duration: Date.now() - pendingCmd.startTime
        })
      }
    }
  }

  /**
   * 清理命令输出
   */
  private cleanOutput(output: string): string {
    return output
      // 移除 ANSI 转义序列
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      // 移除回车符
      .replace(/\r/g, '')
      // 移除开头和结尾的空白行
      .trim()
  }

  /**
   * 转义正则表达式特殊字符
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * 中止正在执行的命令
   */
  abortCommand(id: string): boolean {
    const pendingCmd = this.pendingCommands.get(id)
    if (!pendingCmd) return false

    if (pendingCmd.timeoutId) {
      clearTimeout(pendingCmd.timeoutId)
    }

    this.pendingCommands.delete(id)

    pendingCmd.resolve({
      output: pendingCmd.output,
      exitCode: -1,
      duration: Date.now() - pendingCmd.startTime,
      aborted: true
    })

    // 发送 Ctrl+C 中止当前命令
    const instance = this.instances.get(id)
    if (instance) {
      instance.pty.write('\x03')
    }

    return true
  }

  /**
   * 检查是否有命令正在执行
   */
  isCommandPending(id: string): boolean {
    return this.pendingCommands.has(id)
  }

  /**
   * 在终端执行命令并收集输出
   * 通过检测 shell 提示符来判断命令完成
   */
  executeInTerminal(
    id: string, 
    command: string, 
    timeout: number = 30000
  ): Promise<{ output: string; duration: number }> {
    return new Promise((resolve) => {
      const instance = this.instances.get(id)
      if (!instance) {
        console.error(`[PtyService] 终端实例不存在: id=${id}, 现有实例: ${Array.from(this.instances.keys()).join(', ')}`)
        resolve({ output: `终端实例不存在 (id=${id})`, duration: 0 })
        return
      }

      const startTime = Date.now()
      let output = ''
      let timeoutTimer: NodeJS.Timeout | null = null
      let resolved = false
      let commandStarted = false
      let lastOutputTime = Date.now()
      let checkTimer: NodeJS.Timeout | null = null

      // 去除 ANSI 转义序列和控制字符（用于提示符检测，比标准 stripAnsi 更彻底）
      const stripAnsiAndControlChars = (str: string): string => {
        return stripAnsi(str)
          // 控制字符（保留换行和回车）
          .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '')
      }
      
      // 常见的 shell 提示符模式（更宽松）
      const promptPatterns = [
        /[$#%>❯➜»⟩›]\s*$/,                    // 常见结束符
        /\w+@[\w.-]+\s+[~\/][\w\/.-]*\s*%\s*$/,  // macOS zsh: user@host ~ %
        /\w+@[\w.-]+[^$#%]*[$#%]\s*$/,        // user@host 格式
        /\[\w+@[\w.-]+[^\]]*\]\s*[$#%]\s*$/,  // [user@host path]$ 格式
        /\w+\s*[$#%>❯➜»⟩›]\s*$/,             // 简单的 user$ 格式
        /[~\/][\w\/.-]*\s*[$#%>❯]\s*$/,       // 路径 + 提示符
        />\s*$/,                               // 简单的 > 提示符 (fish/powershell)
      ]
      
      const isPrompt = (text: string): boolean => {
        // 去除 ANSI 后检测
        const cleanText = stripAnsiAndControlChars(text)
        const lines = cleanText.split(/[\r\n]/).filter(l => l.trim())
        const lastLine = lines[lines.length - 1] || ''
        const last80 = cleanText.slice(-80)
        
        const matched = promptPatterns.some(p => p.test(lastLine) || p.test(last80))
        // 调试日志（每 2 秒输出一次检测状态）
        const now = Date.now()
        if (!this.lastPromptLog || now - this.lastPromptLog > 2000) {
          this.lastPromptLog = now
          console.log(`[PtyService] 提示符检测: matched=${matched}, lastLine="${lastLine.slice(-50)}"`)
        }
        if (matched) {
          console.log(`[PtyService] ✓ 检测到提示符: "${lastLine.slice(-40)}"`)
        }
        return matched
      }

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (checkTimer) clearTimeout(checkTimer)
        const idx = instance.dataCallbacks.indexOf(outputHandler)
        if (idx !== -1) {
          instance.dataCallbacks.splice(idx, 1)
        }
      }

      const finish = () => {
        if (resolved) return
        resolved = true
        cleanup()
        
        // 清理输出
        let cleanOutput = output
        const lines = cleanOutput.split(/\r?\n/)
        
        // 移除命令回显（第一行通常包含命令）
        if (lines.length > 0) {
          const cmdStart = command.slice(0, Math.min(15, command.length))
          const cmdIdx = lines.findIndex(l => l.includes(cmdStart))
          if (cmdIdx !== -1 && cmdIdx < 2) {
            lines.splice(0, cmdIdx + 1)
          }
        }
        
        // 移除尾部空行和提示符
        while (lines.length > 0) {
          const lastLine = lines[lines.length - 1]
          if (lastLine.trim() === '' || isPrompt(lastLine)) {
            lines.pop()
          } else {
            break
          }
        }
        
        resolve({
          output: stripAnsi(lines.join('\n').trim()),
          duration: Date.now() - startTime
        })
      }

      // 定期检查是否完成（更可靠的方式）
      const scheduleCheck = () => {
        if (checkTimer) clearTimeout(checkTimer)
        checkTimer = setTimeout(() => {
          if (resolved) return
          
          // 检查条件：命令已开始 + 有输出停止一段时间 + 最后是提示符
          const silenceTime = Date.now() - lastOutputTime
          if (commandStarted && silenceTime >= 200 && isPrompt(output)) {
            // 检测到提示符，命令完成
            finish()
          } else if (commandStarted) {
            // 继续检查（无论是否静默）
            scheduleCheck()
          }
        }, 100)
      }

      // 输出处理器
      const outputHandler = (data: string) => {
        output += data
        lastOutputTime = Date.now()
        
        if (commandStarted) {
          scheduleCheck()
        }
      }

      // 添加输出监听器
      instance.dataCallbacks.push(outputHandler)

      // 设置总超时
      timeoutTimer = setTimeout(() => {
        if (!resolved) {
          output += '\n[命令执行超时]'
          finish()
        }
      }, timeout)

      // 直接发送命令（使用 \r 触发执行，这在 PTY 中是标准的回车符）
      instance.pty.write(command + '\r')
      
      // 标记命令已开始，延迟一点避免误检测命令回显
      setTimeout(() => {
        commandStarted = true
        scheduleCheck()
      }, 150)
    })
  }

  /**
   * 获取 PTY 对应的 shell PID
   */
  getPid(id: string): number | undefined {
    const instance = this.instances.get(id)
    return instance?.pty.pid
  }

  /**
   * 通过系统调用获取终端的当前工作目录（无需在终端中执行命令）
   */
  async getCwd(id: string): Promise<string | null> {
    const instance = this.instances.get(id)
    if (!instance) return null

    const shellPid = instance.pty.pid
    if (!shellPid) return null

    try {
      if (process.platform === 'darwin') {
        // macOS: 使用 lsof 获取 cwd
        const { stdout } = await execAsync(
          `lsof -p ${shellPid} -Fn | grep '^n' | grep 'cwd' -A1 | tail -1 | sed 's/^n//'`,
          { timeout: 2000 }
        )
        const cwd = stdout.trim()
        if (cwd && cwd.startsWith('/')) {
          return cwd
        }
        // 备用方案：使用 pwdx（如果安装了 proctools）
        try {
          const { stdout: pwdxOut } = await execAsync(
            `pwdx ${shellPid} 2>/dev/null | awk '{print $2}'`,
            { timeout: 1000 }
          )
          const pwdxCwd = pwdxOut.trim()
          if (pwdxCwd && pwdxCwd.startsWith('/')) {
            return pwdxCwd
          }
        } catch {
          // pwdx 不可用，忽略
        }
      } else if (process.platform === 'linux') {
        // Linux: 读取 /proc/pid/cwd 符号链接
        const { stdout } = await execAsync(
          `readlink /proc/${shellPid}/cwd`,
          { timeout: 1000 }
        )
        const cwd = stdout.trim()
        if (cwd && cwd.startsWith('/')) {
          return cwd
        }
      } else if (process.platform === 'win32') {
        // Windows: 获取进程 CWD 比较困难
        // 尝试使用 PowerShell 和 WMI 查询，但成功率不高
        // 主要依赖 handleInput 中的命令预测方式
        try {
          // 方法1：使用 WMI 查询进程的 ExecutablePath，然后获取其目录
          // 这不是真正的 CWD，但对于某些 shell 可能有效
          const { stdout } = await execAsync(
            `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${shellPid}').ExecutablePath | Split-Path -Parent"`,
            { timeout: 3000 }
          )
          // 这个方法通常返回的是 shell 可执行文件的目录，不是工作目录，所以不使用
          // 仅作为占位符，实际 Windows 上主要依赖命令预测
        } catch {
          // 忽略错误
        }
        // Windows 上获取其他进程的 CWD 需要 Native API (NtQueryInformationProcess)
        // 这需要额外的原生模块，目前返回 null，依赖命令预测方式
        return null
      }
      return null
    } catch (error) {
      // 静默失败，返回 null 让调用方决定是否回退
      return null
    }
  }

  /**
   * 获取终端状态（判断是否空闲/有命令正在执行）
   */
  async getTerminalStatus(id: string): Promise<TerminalStatus> {
    const instance = this.instances.get(id)
    if (!instance) {
      return {
        isIdle: false,
        stateDescription: '终端实例不存在'
      }
    }

    const shellPid = instance.pty.pid
    
    // 在 Agent 内部追踪的命令
    if (this.pendingCommands.has(id)) {
      return {
        isIdle: false,
        shellPid,
        stateDescription: 'Agent 正在执行命令'
      }
    }

    try {
      if (process.platform === 'darwin') {
        return await this.getTerminalStatusMacOS(shellPid)
      } else if (process.platform === 'linux') {
        return await this.getTerminalStatusLinux(shellPid)
      } else if (process.platform === 'win32') {
        return await this.getTerminalStatusWindows(shellPid)
      } else {
        return {
          isIdle: true,
          shellPid,
          stateDescription: '未知平台，假设空闲'
        }
      }
    } catch (error) {
      console.error('[PtyService] 获取终端状态失败:', error)
      return {
        isIdle: true,
        shellPid,
        stateDescription: '状态检测失败，假设空闲'
      }
    }
  }

  /**
   * macOS 终端状态检测
   */
  private async getTerminalStatusMacOS(shellPid: number): Promise<TerminalStatus> {
    try {
      // 获取 shell 进程状态
      const { stdout: shellOutput } = await execAsync(
        `ps -o pid=,stat=,comm= -p ${shellPid}`,
        { timeout: 2000 }
      )

      const shellLine = shellOutput.trim()
      if (!shellLine) {
        return {
          isIdle: true,
          shellPid,
          stateDescription: 'Shell 进程不存在或已退出'
        }
      }

      const shellParts = shellLine.split(/\s+/)
      const shellStat = shellParts[1] || ''
      const shellComm = shellParts[2] || 'shell'

      // 使用 pgrep 获取子进程（macOS 不支持 ps --ppid）
      let childPids: number[] = []
      try {
        const { stdout: pgrepOutput } = await execAsync(
          `pgrep -P ${shellPid}`,
          { timeout: 2000 }
        )
        childPids = pgrepOutput.trim().split('\n')
          .map(p => parseInt(p.trim()))
          .filter(p => !isNaN(p))
      } catch {
        // pgrep 没有找到子进程时返回非零退出码，这是正常的
        childPids = []
      }

      // 检查是否有子进程（正在执行的命令）
      if (childPids.length > 0) {
        // 获取第一个子进程的详细信息
        try {
          const { stdout: childOutput } = await execAsync(
            `ps -o pid=,stat=,comm= -p ${childPids[0]}`,
            { timeout: 2000 }
          )
          const childLine = childOutput.trim()
          if (childLine) {
            const childParts = childLine.split(/\s+/)
            const childPid = parseInt(childParts[0])
            const childStat = childParts[1] || ''
            const childComm = childParts[2] || 'unknown'
            
            return {
              isIdle: false,
              foregroundProcess: childComm,
              foregroundPid: childPid,
              shellPid,
              stateDescription: `正在执行: ${childComm} (PID: ${childPid}, 状态: ${childStat})`
            }
          }
        } catch {
          // 忽略获取子进程详情的错误
        }
        
        return {
          isIdle: false,
          foregroundPid: childPids[0],
          shellPid,
          stateDescription: `正在执行子进程 (PID: ${childPids[0]})`
        }
      }

      // 没有子进程，检查 shell 状态
      // S = sleeping (可中断睡眠), + = 前台进程组
      const isIdle = shellStat.includes('S') && shellStat.includes('+')
      
      return {
        isIdle,
        foregroundProcess: shellComm,
        foregroundPid: shellPid,
        shellPid,
        stateDescription: isIdle ? '空闲，等待用户输入' : `Shell 状态: ${shellStat}`
      }
    } catch {
      return this.getTerminalStatusSimple(shellPid)
    }
  }

  /**
   * Linux 终端状态检测
   */
  private async getTerminalStatusLinux(shellPid: number): Promise<TerminalStatus> {
    try {
      const { stdout: statContent } = await execAsync(
        `cat /proc/${shellPid}/stat 2>/dev/null`,
        { timeout: 1000 }
      )
      
      const statParts = statContent.trim().split(' ')
      const tpgid = parseInt(statParts[7])
      const pgrp = parseInt(statParts[4])

      if (tpgid === pgrp) {
        return {
          isIdle: true,
          foregroundProcess: 'shell',
          foregroundPid: shellPid,
          shellPid,
          stateDescription: '空闲，等待用户输入'
        }
      }

      try {
        const { stdout: fgStatContent } = await execAsync(
          `cat /proc/${tpgid}/stat 2>/dev/null`,
          { timeout: 1000 }
        )
        const fgParts = fgStatContent.trim().split(' ')
        const commMatch = fgStatContent.match(/\(([^)]+)\)/)
        const fgComm = commMatch ? commMatch[1] : 'unknown'
        const fgState = fgParts[2]

        return {
          isIdle: false,
          foregroundProcess: fgComm,
          foregroundPid: tpgid,
          shellPid,
          stateDescription: `正在执行: ${fgComm} (PID: ${tpgid}, 状态: ${fgState})`
        }
      } catch {
        return {
          isIdle: false,
          foregroundPid: tpgid,
          shellPid,
          stateDescription: `有命令正在执行 (前台进程组: ${tpgid})`
        }
      }
    } catch {
      return this.getTerminalStatusSimple(shellPid)
    }
  }

  /**
   * Windows 终端状态检测
   */
  private async getTerminalStatusWindows(shellPid: number): Promise<TerminalStatus> {
    try {
      // 使用 PowerShell 获取子进程
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${shellPid}' | Select-Object ProcessId,Name | ConvertTo-Json"`,
        { timeout: 3000 }
      )

      const trimmed = stdout.trim()
      if (!trimmed || trimmed === '' || trimmed === 'null') {
        // 没有子进程，终端空闲
        return {
          isIdle: true,
          foregroundProcess: 'shell',
          foregroundPid: shellPid,
          shellPid,
          stateDescription: '空闲，等待用户输入'
        }
      }

      try {
        // 解析 JSON 结果
        let processes = JSON.parse(trimmed)
        // PowerShell 单个结果时返回对象，多个结果时返回数组
        if (!Array.isArray(processes)) {
          processes = [processes]
        }

        if (processes.length > 0) {
          const firstProcess = processes[0]
          return {
            isIdle: false,
            foregroundProcess: firstProcess.Name || 'unknown',
            foregroundPid: firstProcess.ProcessId,
            shellPid,
            stateDescription: `正在执行: ${firstProcess.Name || 'unknown'} (PID: ${firstProcess.ProcessId})`
          }
        }
      } catch {
        // JSON 解析失败，但有输出，说明可能有子进程
        return {
          isIdle: false,
          shellPid,
          stateDescription: '有命令正在执行'
        }
      }

      return {
        isIdle: true,
        foregroundProcess: 'shell',
        foregroundPid: shellPid,
        shellPid,
        stateDescription: '空闲，等待用户输入'
      }
    } catch (error) {
      // PowerShell 不可用时，尝试使用 wmic（旧版 Windows）
      try {
        const { stdout } = await execAsync(
          `wmic process where "ParentProcessId=${shellPid}" get ProcessId,Name /format:csv`,
          { timeout: 3000 }
        )
        
        const lines = stdout.trim().split('\n').filter((l: string) => l.trim() && !l.includes('Node,'))
        
        if (lines.length > 1) { // 第一行是标题
          const parts = lines[1].split(',')
          const name = parts[1] || 'unknown'
          const pid = parseInt(parts[2]) || 0
          
          return {
            isIdle: false,
            foregroundProcess: name,
            foregroundPid: pid,
            shellPid,
            stateDescription: `正在执行: ${name} (PID: ${pid})`
          }
        }
        
        return {
          isIdle: true,
          foregroundProcess: 'shell',
          foregroundPid: shellPid,
          shellPid,
          stateDescription: '空闲，等待用户输入'
        }
      } catch {
        // 两种方法都失败，返回默认空闲状态
        return {
          isIdle: true,
          shellPid,
          stateDescription: 'Windows 状态检测失败，假设空闲'
        }
      }
    }
  }

  /**
   * 简单的终端状态检测（回退方案）
   */
  private async getTerminalStatusSimple(shellPid: number): Promise<TerminalStatus> {
    try {
      const { stdout } = await execAsync(
        `pgrep -P ${shellPid} 2>/dev/null || echo ""`,
        { timeout: 1000 }
      )
      
      const childPids = stdout.trim().split('\n').filter((l: string) => l.trim())
      
      if (childPids.length > 0) {
        return {
          isIdle: false,
          shellPid,
          stateDescription: `有 ${childPids.length} 个子进程正在运行`
        }
      }
      
      return {
        isIdle: true,
        shellPid,
        stateDescription: '空闲，等待用户输入'
      }
    } catch {
      return {
        isIdle: true,
        shellPid,
        stateDescription: '状态未知，假设空闲'
      }
    }
  }
}

/**
 * 终端状态信息
 */
export interface TerminalStatus {
  isIdle: boolean
  foregroundProcess?: string
  foregroundPid?: number
  stateDescription: string
  shellPid?: number
}

