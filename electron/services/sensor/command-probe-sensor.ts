/**
 * Command Probe Sensor - 命令探针传感器
 *
 * 通用探针：定时执行命令，根据输出变化/正则匹配/退出码触发事件。
 * Agent 通过 watch_create 自由组合命令，无需为每种数据源写专用传感器。
 *
 * 跨平台：自动检测 shell（Unix→/bin/sh, Windows→powershell）
 */
import { exec, spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import type { Sensor, SensorEvent, EventBus } from './types'
import { createLogger } from '../../utils/logger'
import { resolveDefaultShell, getShellSpawnArgs } from '../../utils/shell'
import { ChunkTextDecoder } from '../../utils/encoding'

const log = createLogger('CommandProbeSensor')

export interface CommandProbeTarget {
  watchId: string
  command: string
  shell?: string
  interval: number
  triggerOn: 'output_changed' | 'regex_match' | 'exit_code_nonzero'
  pattern?: string
  workingDirectory?: string
}

interface ProbeState {
  lastOutputHash: string
  lastExitCode: number | null
  lastOutput: string
}

const MIN_INTERVAL = 10
const MAX_TARGETS = 50
const COMMAND_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 64 * 1024

export class CommandProbeSensor implements Sensor {
  readonly id = 'command_probe'
  readonly name = 'Command Probe'

  private _running = false
  private eventBus: EventBus
  private targets: Map<string, CommandProbeTarget> = new Map()
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private states: Map<string, ProbeState> = new Map()
  private runningProcesses: Map<string, ChildProcess> = new Map()

  get running(): boolean {
    return this._running
  }

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus
  }

  async start(): Promise<void> {
    if (this._running) return
    this._running = true

    for (const [watchId, target] of this.targets) {
      this.startProbing(watchId, target)
    }

    log.info(`Started with ${this.targets.size} targets`)
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false

    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
    this.states.clear()

    for (const child of this.runningProcesses.values()) {
      try { child.kill() } catch { /* ignore */ }
    }
    this.runningProcesses.clear()

    log.info('Stopped')
  }

  addTarget(watchId: string, target: Omit<CommandProbeTarget, 'watchId'>): void {
    if (this.targets.size >= MAX_TARGETS) {
      log.warn(`Target limit reached (${MAX_TARGETS}), rejecting: ${watchId}`)
      return
    }

    const interval = Math.max(target.interval, MIN_INTERVAL)
    const fullTarget: CommandProbeTarget = { ...target, interval, watchId }
    this.targets.set(watchId, fullTarget)

    if (this._running) {
      this.startProbing(watchId, fullTarget)
    }
  }

  removeTarget(watchId: string): void {
    this.targets.delete(watchId)
    this.stopProbing(watchId)
    this.states.delete(watchId)
    const child = this.runningProcesses.get(watchId)
    if (child) {
      try { child.kill() } catch { /* ignore */ }
      this.runningProcesses.delete(watchId)
    }
  }

  getTargetCount(): number {
    return this.targets.size
  }

  shouldAutoStart(): boolean {
    return this.targets.size > 0
  }

  private startProbing(watchId: string, target: CommandProbeTarget): void {
    this.stopProbing(watchId)

    this.probe(watchId, target)

    const timer = setInterval(() => {
      this.probe(watchId, target)
    }, target.interval * 1000)

    this.timers.set(watchId, timer)
  }

  private stopProbing(watchId: string): void {
    const timer = this.timers.get(watchId)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(watchId)
    }
  }

  private probe(watchId: string, target: CommandProbeTarget): void {
    if (this.runningProcesses.has(watchId)) return

    const env = { ...process.env }
    if (process.platform !== 'win32') {
      env.LANG = env.LANG || 'en_US.UTF-8'
    }

    const cwd = target.workingDirectory || undefined
    // 用户指定了 shell 路径时，走 spawn 的 shell:true 模式让 Node 自行处理跨平台调用；
    // 否则用 resolveDefaultShell + getShellSpawnArgs，确保 Windows 上 PowerShell
    // 走 -Command 参数（旧版 exec({shell: powershell.exe}) 会被 Node 套进 cmd /d /s /c 模板，PS 不认）
    let child: ChildProcess
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let timeoutId: NodeJS.Timeout | null = null
    let done = false

    const finalize = () => {
      if (done) return
      done = true
      if (timeoutId) clearTimeout(timeoutId)
      this.runningProcesses.delete(watchId)
      if (!this._running) return

      const code = exitCode ?? 0
      const output = stdout.trim()
      const outputHash = hashString(output)
      const prev = this.states.get(watchId)

      this.states.set(watchId, {
        lastOutputHash: outputHash,
        lastExitCode: typeof code === 'number' ? code : null,
        lastOutput: output.substring(0, 2000),
      })

      if (!prev) return

      let shouldTrigger = false
      let reason = ''

      switch (target.triggerOn) {
        case 'output_changed':
          if (prev.lastOutputHash !== outputHash) {
            shouldTrigger = true
            reason = 'output changed'
          }
          break

        case 'regex_match':
          if (target.pattern) {
            try {
              if (new RegExp(target.pattern).test(output)) {
                shouldTrigger = true
                reason = `regex matched: ${target.pattern}`
              }
            } catch {
              log.warn(`Invalid regex for ${watchId}: ${target.pattern}`)
            }
          }
          break

        case 'exit_code_nonzero':
          if (code !== 0) {
            shouldTrigger = true
            reason = `exit code: ${code}`
          }
          break
      }

      if (shouldTrigger) {
        const event: SensorEvent = {
          id: `cp-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
          type: 'command_probe',
          source: this.id,
          timestamp: Date.now(),
          watchId,
          payload: {
            command: target.command,
            triggerOn: target.triggerOn,
            reason,
            exitCode: code,
            output: output.substring(0, 2000),
            previousOutput: prev.lastOutput,
            stderr: stderr.trim().substring(0, 500),
          },
          priority: 'normal',
        }

        log.info(`Probe triggered for ${watchId}: ${reason}`)
        this.eventBus.emit(event)
      }
    }

    if (target.shell) {
      // 用户显式指定 shell：用 exec 的 shell 选项兼容旧行为
      child = exec(target.command, {
        shell: target.shell,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        cwd,
        env,
        windowsHide: true,
      }, (error, out, err) => {
        if (error) {
          exitCode = error.code ?? 1
        }
        stdout = out || ''
        stderr = err || ''
        finalize()
      })
    } else {
      const resolved = resolveDefaultShell()
      const args = getShellSpawnArgs(resolved.kind, target.command)
      child = spawn(resolved.path, args, {
        cwd,
        env,
        windowsHide: true,
      })
      const stdoutText = new ChunkTextDecoder()
      const stderrText = new ChunkTextDecoder()
      const takeOutput = () => {
        stdout += stdoutText.end()
        stderr += stderrText.end()
        if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES)
        if (stderr.length > MAX_OUTPUT_BYTES * 0.1) stderr = stderr.slice(0, Math.floor(MAX_OUTPUT_BYTES * 0.1))
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += stdoutText.push(chunk)
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_OUTPUT_BYTES)
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += stderrText.push(chunk)
        if (stderr.length > MAX_OUTPUT_BYTES * 0.1) {
          stderr = stderr.slice(0, Math.floor(MAX_OUTPUT_BYTES * 0.1))
        }
      })
      child.on('error', (err) => {
        stderr += `\n[probe spawn error] ${err.message}`
        exitCode = 1
        takeOutput()
        finalize()
      })
      child.on('close', (code, signal) => {
        exitCode = code ?? (signal ? 1 : 0)
        takeOutput()
        finalize()
      })

      // 超时强杀
      timeoutId = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* 已退出 */ }
        setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* 已退出 */ }
          takeOutput()
          finalize()
        }, 500)
      }, COMMAND_TIMEOUT_MS)
    }

    this.runningProcesses.set(watchId, child)
  }
}

function hashString(str: string): string {
  return createHash('md5').update(str).digest('hex')
}
