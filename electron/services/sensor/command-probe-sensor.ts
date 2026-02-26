/**
 * Command Probe Sensor - 命令探针传感器
 *
 * 通用探针：定时执行命令，根据输出变化/正则匹配/退出码触发事件。
 * Agent 通过 watch_create 自由组合命令，无需为每种数据源写专用传感器。
 *
 * 跨平台：自动检测 shell（Unix→/bin/sh, Windows→powershell）
 */
import { exec, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import type { Sensor, SensorEvent, EventBus } from './types'
import { createLogger } from '../../utils/logger'

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

    const shell = target.shell || getDefaultShell()
    const env = { ...process.env }
    if (process.platform !== 'win32') {
      env.LANG = env.LANG || 'en_US.UTF-8'
    }

    const options = {
      shell,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      cwd: target.workingDirectory || undefined,
      env,
      windowsHide: true,
    }

    const child = exec(target.command, options, (error, stdout, stderr) => {
      this.runningProcesses.delete(watchId)
      if (!this._running) return

      const exitCode = error?.code ?? (error ? 1 : 0)
      const output = (stdout || '').trim()
      const outputHash = hashString(output)
      const prev = this.states.get(watchId)

      this.states.set(watchId, {
        lastOutputHash: outputHash,
        lastExitCode: typeof exitCode === 'number' ? exitCode : null,
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
          if (exitCode !== 0) {
            shouldTrigger = true
            reason = `exit code: ${exitCode}`
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
            exitCode,
            output: output.substring(0, 2000),
            previousOutput: prev.lastOutput,
            stderr: (stderr || '').trim().substring(0, 500),
          },
          priority: 'normal',
        }

        log.info(`Probe triggered for ${watchId}: ${reason}`)
        this.eventBus.emit(event)
      }
    })

    this.runningProcesses.set(watchId, child)
  }
}

function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec?.toLowerCase().includes('powershell') ? process.env.ComSpec : 'powershell.exe'
  }
  return process.env.SHELL || '/bin/sh'
}

function hashString(str: string): string {
  return createHash('md5').update(str).digest('hex')
}
