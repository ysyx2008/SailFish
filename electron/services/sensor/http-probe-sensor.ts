/**
 * HTTP Probe Sensor - HTTP 探针传感器
 *
 * 通用探针：定时发起 HTTP 请求，根据状态码/响应体变化/正则匹配触发事件。
 * 纯 Node.js 实现，100% 跨平台。
 */
import { createHash } from 'crypto'
import type { Sensor, SensorEvent, EventBus } from './types'
import { createLogger } from '../../utils/logger'

const log = createLogger('HttpProbeSensor')

export interface HttpProbeTarget {
  watchId: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  interval: number
  triggerOn: 'status_changed' | 'status_error' | 'body_changed' | 'regex_match'
  pattern?: string
  timeout?: number
}

interface ProbeState {
  lastStatus: number | null
  lastBodyHash: string
  lastBody: string
}

const MIN_INTERVAL = 10
const MAX_TARGETS = 50
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_BODY_CAPTURE = 8 * 1024

export class HttpProbeSensor implements Sensor {
  readonly id = 'http_probe'
  readonly name = 'HTTP Probe'

  private _running = false
  private eventBus: EventBus
  private targets: Map<string, HttpProbeTarget> = new Map()
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private states: Map<string, ProbeState> = new Map()

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

    log.info('Stopped')
  }

  addTarget(watchId: string, target: Omit<HttpProbeTarget, 'watchId'>): void {
    if (this.targets.size >= MAX_TARGETS) {
      log.warn(`Target limit reached (${MAX_TARGETS}), rejecting: ${watchId}`)
      return
    }

    const interval = Math.max(target.interval, MIN_INTERVAL)
    const fullTarget: HttpProbeTarget = { ...target, interval, watchId }
    this.targets.set(watchId, fullTarget)

    if (this._running) {
      this.startProbing(watchId, fullTarget)
    }
  }

  removeTarget(watchId: string): void {
    this.targets.delete(watchId)
    this.stopProbing(watchId)
    this.states.delete(watchId)
  }

  getTargetCount(): number {
    return this.targets.size
  }

  shouldAutoStart(): boolean {
    return this.targets.size > 0
  }

  private startProbing(watchId: string, target: HttpProbeTarget): void {
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

  private async probe(watchId: string, target: HttpProbeTarget): Promise<void> {
    let status: number | null = null
    let body = ''
    let errorMsg = ''

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        target.timeout || DEFAULT_TIMEOUT_MS
      )

      const response = await fetch(target.url, {
        method: target.method || 'GET',
        headers: target.headers,
        body: target.body || undefined,
        signal: controller.signal,
        redirect: 'follow',
      })

      clearTimeout(timeoutId)
      status = response.status
      body = (await response.text()).substring(0, MAX_BODY_CAPTURE)
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err)
      log.debug(`Probe failed for ${watchId}: ${errorMsg}`)
    }

    if (!this._running) return

    const bodyHash = hashString(body)
    const prev = this.states.get(watchId)

    this.states.set(watchId, {
      lastStatus: status,
      lastBodyHash: bodyHash,
      lastBody: body.substring(0, 2000),
    })

    if (!prev) return

    let shouldTrigger = false
    let reason = ''

    switch (target.triggerOn) {
      case 'status_changed':
        if (prev.lastStatus !== status) {
          shouldTrigger = true
          reason = `status changed: ${prev.lastStatus} → ${status ?? 'error'}`
        }
        break

      case 'status_error':
        if (status === null || status >= 400) {
          shouldTrigger = true
          reason = status === null
            ? `request failed: ${errorMsg}`
            : `HTTP ${status}`
        }
        break

      case 'body_changed':
        if (prev.lastBodyHash !== bodyHash) {
          shouldTrigger = true
          reason = 'response body changed'
        }
        break

      case 'regex_match':
        if (target.pattern) {
          try {
            if (new RegExp(target.pattern).test(body)) {
              shouldTrigger = true
              reason = `regex matched: ${target.pattern}`
            }
          } catch {
            log.warn(`Invalid regex for ${watchId}: ${target.pattern}`)
          }
        }
        break
    }

    if (shouldTrigger) {
      const event: SensorEvent = {
        id: `hp-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
        type: 'http_probe',
        source: this.id,
        timestamp: Date.now(),
        watchId,
        payload: {
          url: target.url,
          method: target.method || 'GET',
          triggerOn: target.triggerOn,
          reason,
          status,
          body: body.substring(0, 2000),
          previousBody: prev.lastBody,
          previousStatus: prev.lastStatus,
          error: errorMsg || undefined,
        },
        priority: 'normal',
      }

      log.info(`Probe triggered for ${watchId}: ${reason}`)
      this.eventBus.emit(event)
    }
  }
}

function hashString(str: string): string {
  return createHash('md5').update(str).digest('hex')
}
