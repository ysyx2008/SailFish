import { spawn, ChildProcess } from 'child_process'
import * as os from 'os'
import stripAnsi from 'strip-ansi'
import { resolveDefaultShell, getShellSpawnArgs } from '../utils/shell'
import { ChunkTextDecoder } from '../utils/encoding'

export interface CommandResult {
  output: string
  exitCode: number
  duration: number
  aborted?: boolean
}

interface PendingExecution {
  process: ChildProcess
  resolve: (result: CommandResult) => void
  startTime: number
  output: string
  timeoutId?: NodeJS.Timeout
}

/**
 * 命令执行服务
 * 在后台静默执行命令，不干扰用户终端
 */
export class CommandExecutorService {
  private executions: Map<string, PendingExecution> = new Map()

  /**
   * 执行命令并返回结果
   * @param command 要执行的命令
   * @param cwd 工作目录（可选）
   * @param timeout 超时时间（毫秒），默认 30000
   */
  execute(
    command: string,
    cwd?: string,
    timeout: number = 30000
  ): Promise<CommandResult> {
    const id = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
    const startTime = Date.now()
    const workDir = cwd || os.homedir()

    return new Promise((resolve) => {
      // 统一走 utils/shell.ts：根据 shell 类型（powershell/cmd/bash）构建正确参数
      const shellResolved = resolveDefaultShell()
      const shellArgs = getShellSpawnArgs(shellResolved.kind, command)

      const proc = spawn(shellResolved.path, shellArgs, {
        cwd: workDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        },
        shell: false
      })

      let output = ''
      let errorOutput = ''
      const stdoutText = new ChunkTextDecoder()
      const stderrText = new ChunkTextDecoder()
      const flush = () => {
        output += stdoutText.end()
        errorOutput += stderrText.end()
      }

      proc.stdout?.on('data', (data: Buffer) => {
        output += stdoutText.push(data)
      })

      proc.stderr?.on('data', (data: Buffer) => {
        errorOutput += stderrText.push(data)
      })

      // 设置超时
      const timeoutId = setTimeout(() => {
        proc.kill('SIGTERM')
        flush()
        this.executions.delete(id)
        resolve({
          output: output + errorOutput,
          exitCode: -1,
          duration: Date.now() - startTime,
          aborted: true
        })
      }, timeout)

      // 保存执行记录
      this.executions.set(id, {
        process: proc,
        resolve,
        startTime,
        output: '',
        timeoutId
      })

      // 进程结束
      proc.on('close', (code) => {
        clearTimeout(timeoutId)
        flush()
        this.executions.delete(id)

        // 合并输出，优先显示 stdout，如果为空则显示 stderr
        const finalOutput = output || errorOutput

        resolve({
          output: this.cleanOutput(finalOutput),
          exitCode: code ?? 0,
          duration: Date.now() - startTime
        })
      })

      // 进程错误
      proc.on('error', (err) => {
        clearTimeout(timeoutId)
        this.executions.delete(id)
        resolve({
          output: `执行错误: ${err.message}`,
          exitCode: -1,
          duration: Date.now() - startTime
        })
      })
    })
  }

  /**
   * 清理输出
   */
  private cleanOutput(output: string): string {
    return stripAnsi(output)
      // 移除回车符
      .replace(/\r/g, '')
      // 移除开头和结尾的空白
      .trim()
  }

  /**
   * 中止所有正在执行的命令
   */
  abortAll(): void {
    this.executions.forEach((exec, id) => {
      if (exec.timeoutId) {
        clearTimeout(exec.timeoutId)
      }
      exec.process.kill('SIGTERM')
      exec.resolve({
        output: exec.output,
        exitCode: -1,
        duration: Date.now() - exec.startTime,
        aborted: true
      })
      this.executions.delete(id)
    })
  }
}

