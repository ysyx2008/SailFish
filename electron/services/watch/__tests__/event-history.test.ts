import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryEventBus } from '../../sensor/event-bus'
import type { SensorEvent } from '../../sensor/types'
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('调试事件历史不常驻大正文', () => {
  it('执行链路收到全文，调试历史明确标识摘要', () => {
    const bus = new MemoryEventBus()
    const event: SensorEvent = { id: 'test', type: 'command_probe', source: 'test', timestamp: 0, priority: 'normal', payload: { output: 'x'.repeat(1024 * 1024) } }
    let delivered: SensorEvent | undefined
    bus.on(e => { delivered = e })
    bus.emit(event)
    expect(delivered).toBe(event)
    expect(delivered?.payload.output).toBe(event.payload.output)
    const recent = bus.recentEvents()[0]
    expect(recent.payload.previewOnly).toBe(true)
    expect(JSON.stringify(recent).length).toBeLessThan(500)
    expect(recent.payload.output).toBeUndefined()
  })
  it('小事件仍完整保留，无法序列化的调试内容不会阻断交接', () => {
    const bus = new MemoryEventBus()
    const event: SensorEvent = { id: 'small', type: 'heartbeat', source: 'test', timestamp: 0, priority: 'normal', payload: { value: 1 } }
    bus.emit(event)
    expect(bus.recentEvents()[0]).toBe(event)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => bus.emit({ ...event, id: 'circular', payload: circular })).not.toThrow()
  })
})
