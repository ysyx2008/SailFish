/**
 * 入库让路闸的时序测试
 *
 * 这里全是并发时序，靠人眼看不住：原 bug 正是「清理在入库中途动手」造成的，
 * 现象是文档列表里有、搜索搜不到。用手动 resolve 的 promise 把交错编排出来。
 */
import { describe, it, expect, vi } from 'vitest'
import { IngestGate } from '../ingest-gate'

/** 可手动放行的任务，用来把两个异步过程卡在想要的交错点上 */
function gated<T>(value: T) {
  let release!: () => void
  const started = { yes: false }
  const blocker = new Promise<void>(resolve => {
    release = resolve
  })
  const task = async () => {
    started.yes = true
    await blocker
    return value
  }
  return { task, release, started }
}

describe('IngestGate', () => {
  it('没人占着时清理照常跑', async () => {
    const gate = new IngestGate(vi.fn())
    const cleanup = vi.fn().mockResolvedValue(undefined)

    expect(await gate.cleanup(cleanup)).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('入库进行中，清理不开工', async () => {
    const reschedule = vi.fn()
    const gate = new IngestGate(reschedule)
    const ingest = gated('doc-1')
    const cleanup = vi.fn().mockResolvedValue(undefined)

    const ingesting = gate.ingest(ingest.task)
    await Promise.resolve()
    expect(gate.ingesting).toBe(true)

    expect(await gate.cleanup(cleanup)).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()

    ingest.release()
    expect(await ingesting).toBe('doc-1')
  })

  it('让路的清理在入库收尾后补做一次', async () => {
    const reschedule = vi.fn()
    const gate = new IngestGate(reschedule)
    const ingest = gated('doc-1')

    const ingesting = gate.ingest(ingest.task)
    await Promise.resolve()
    await gate.cleanup(vi.fn())

    expect(reschedule).not.toHaveBeenCalled()
    ingest.release()
    await ingesting

    expect(reschedule).toHaveBeenCalledOnce()
  })

  it('没让路过就不补做，免得空转', async () => {
    const reschedule = vi.fn()
    const gate = new IngestGate(reschedule)

    await gate.ingest(async () => 'doc-1')

    expect(reschedule).not.toHaveBeenCalled()
  })

  it('多个入库并行时，最后一个收尾才补做，且只补一次', async () => {
    const reschedule = vi.fn()
    const gate = new IngestGate(reschedule)
    const first = gated('a')
    const second = gated('b')

    const p1 = gate.ingest(first.task)
    const p2 = gate.ingest(second.task)
    await Promise.resolve()
    await gate.cleanup(vi.fn())

    first.release()
    await p1
    expect(reschedule).not.toHaveBeenCalled()

    second.release()
    await p2
    expect(reschedule).toHaveBeenCalledOnce()
  })

  it('清理进行中，入库等它结束再动手', async () => {
    const gate = new IngestGate(vi.fn())
    const cleanup = gated(undefined)
    const order: string[] = []

    const cleaning = gate.cleanup(async () => {
      await cleanup.task()
      order.push('清理完成')
    })
    await Promise.resolve()

    const ingesting = gate.ingest(async () => {
      order.push('开始写入')
      return 'doc-1'
    })

    // 清理还卡着，写入一步都不能迈出去
    await Promise.resolve()
    expect(order).toEqual([])

    cleanup.release()
    await cleaning
    await ingesting

    expect(order).toEqual(['清理完成', '开始写入'])
  })

  it('动手前发现有入库插进来，shouldYield 让路并登记补做', async () => {
    const reschedule = vi.fn()
    const gate = new IngestGate(reschedule)
    const ingest = gated('doc-1')

    // 清理已开工（此刻还没人入库），走到真正删除之前才来的入库
    const cleaning = gate.cleanup(async () => {
      const ingesting = gate.ingest(ingest.task)
      await Promise.resolve()
      expect(gate.shouldYield()).toBe(true)
      ingest.release()
      await ingesting
    })

    await cleaning
    expect(reschedule).toHaveBeenCalledOnce()
  })

  it('没人入库时 shouldYield 不让路', () => {
    const gate = new IngestGate(vi.fn())
    expect(gate.shouldYield()).toBe(false)
  })

  it('入库抛错也要把闸放开', async () => {
    const reschedule = vi.fn()
    const gate = new IngestGate(reschedule)

    await expect(gate.ingest(async () => { throw new Error('入库失败') })).rejects.toThrow('入库失败')

    expect(gate.ingesting).toBe(false)
    expect(await gate.cleanup(vi.fn().mockResolvedValue(undefined))).toBe(true)
  })

  it('清理抛错也要把闸放开，不能把后续入库永久挡住', async () => {
    const gate = new IngestGate(vi.fn())

    await expect(gate.cleanup(async () => { throw new Error('清理失败') })).rejects.toThrow('清理失败')

    expect(gate.cleaning).toBe(false)
    expect(await gate.ingest(async () => 'doc-1')).toBe('doc-1')
  })

  it('清理在跑时再来一次清理，不会并发动手', async () => {
    const gate = new IngestGate(vi.fn())
    const first = gated(undefined)
    const cleanup = vi.fn().mockImplementation(first.task)

    const a = gate.cleanup(cleanup)
    await Promise.resolve()
    const b = gate.cleanup(cleanup)

    first.release()
    expect(await a).toBe(true)
    expect(await b).toBe(false)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('reset 清掉残留，不把下一轮清理挡在外面', async () => {
    const gate = new IngestGate(vi.fn())
    const ingest = gated('doc-1')

    const ingesting = gate.ingest(ingest.task)
    await Promise.resolve()
    expect(gate.ingesting).toBe(true)

    gate.reset()
    expect(gate.ingesting).toBe(false)
    expect(await gate.cleanup(vi.fn().mockResolvedValue(undefined))).toBe(true)

    ingest.release()
    await ingesting
  })
})
