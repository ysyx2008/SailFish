/**
 * 联络等任务回执（TaskWatch）：这一轮欠着回执就不收工、等待卡走时间、
 * 用户插话让路、到点醒一下不换卡、按停只是不再等（任务本身不动）
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

import { TaskWatch, taskWatchKey, type TaskReceiptLedger } from '../tools/task-watch'
import type { ToolExecutorConfig } from '../tools/types'

function makeLedger(owed = true): TaskReceiptLedger & { owed: boolean } {
  const ledger = { owed, isOwed: vi.fn(() => ledger.owed) }
  return ledger
}

function makeExecutor() {
  let nextId = 0
  const steps: Array<{ id: string; type: string; content?: string; toolName?: string }> = []
  const executor = {
    addStep: vi.fn((step: { type: string; content?: string; toolName?: string }) => {
      const stored = { id: `s${nextId++}`, ...step }
      steps.push(stored)
      return stored
    }),
    updateStep: vi.fn(),
  } as unknown as ToolExecutorConfig
  return { executor, steps }
}

describe('TaskWatch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('欠着回执就是还在等；账上销了或放手之后就不等了', () => {
    const ledger = makeLedger(true)
    const watch = new TaskWatch(ledger, 'assistant-a', '查日志', makeExecutor().executor)

    expect(watch.key).toBe(taskWatchKey('assistant-a'))
    expect(watch.isPending()).toBe(true)

    ledger.owed = false
    expect(watch.isPending()).toBe(false)

    ledger.owed = true
    watch.release()
    expect(watch.isPending()).toBe(false)
  })

  it('这一轮闲下来开始等：画一张等待卡，每秒更新已等多久；重复开始不重复画', () => {
    vi.useFakeTimers()
    const { executor, steps } = makeExecutor()
    const watch = new TaskWatch(makeLedger(), 'assistant-a', '查日志', executor)

    watch.holdStarted()
    watch.holdStarted()

    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ type: 'tool_call', toolName: 'manage_tasks' })
    expect(steps[0].content).toContain('查日志')

    vi.advanceTimersByTime(3000)
    expect(executor.updateStep).toHaveBeenCalledTimes(3)
    watch.release()
  })

  it('已经不欠回执就不画卡', () => {
    const { executor, steps } = makeExecutor()
    const watch = new TaskWatch(makeLedger(false), 'assistant-a', '查日志', executor)

    watch.holdStarted()

    expect(steps).toHaveLength(0)
  })

  it('到点醒一下不是任务有回音：卡接着走，不换成结果行', () => {
    vi.useFakeTimers()
    const { executor, steps } = makeExecutor()
    const watch = new TaskWatch(makeLedger(), 'assistant-a', '查日志', executor)
    watch.holdStarted()

    watch.holdEnded(true)
    expect(steps).toHaveLength(1)

    vi.advanceTimersByTime(2000)
    expect(executor.updateStep).toHaveBeenCalledTimes(2)
    expect(watch.checkpoint()).toBeUndefined()
    watch.release()
  })

  it('用户插话把这一轮叫醒、任务还没回：卡收成「先回答你」，之后还接着等', () => {
    vi.useFakeTimers()
    const { executor, steps } = makeExecutor()
    const watch = new TaskWatch(makeLedger(true), 'assistant-a', '查日志', executor)
    watch.holdStarted()

    watch.holdEnded(false)

    expect(steps[1]).toMatchObject({ type: 'tool_result', toolName: 'manage_tasks' })
    expect(steps[1].content).toContain('先回答你')
    expect(watch.isPending()).toBe(true)

    vi.advanceTimersByTime(3000)
    expect(executor.updateStep).not.toHaveBeenCalled()
  })

  it('任务回执送到把这一轮叫醒：卡收成「任务有回音了」', () => {
    const ledger = makeLedger(true)
    const { executor, steps } = makeExecutor()
    const watch = new TaskWatch(ledger, 'assistant-a', '查日志', executor)
    watch.holdStarted()

    ledger.owed = false
    watch.holdEnded(false)

    expect(steps[1].content).toContain('有回音')
  })

  it('用户按停联络：只是不再等，卡标成已停，没有要留给下一轮的交代', () => {
    vi.useFakeTimers()
    const ledger = makeLedger(true)
    const { executor, steps } = makeExecutor()
    const watch = new TaskWatch(ledger, 'assistant-a', '查日志', executor)
    watch.holdStarted()

    const note = watch.stop()

    expect(note).toBeUndefined()
    expect(watch.isPending()).toBe(false)
    expect(executor.updateStep).toHaveBeenCalledWith('s0', expect.objectContaining({ success: false, isStreaming: false }))
    expect(steps[1].content).toContain('任务本身还在做')
    // 账不动：任务做完后的回执仍会送来
    expect(ledger.isOwed('assistant-a')).toBe(true)

    vi.advanceTimersByTime(3000)
    expect(executor.updateStep).toHaveBeenCalledTimes(1)
  })

  it('再交代同一场：沿用这一份，重新计时', () => {
    vi.useFakeTimers()
    const first = makeExecutor()
    const second = makeExecutor()
    const watch = new TaskWatch(makeLedger(), 'assistant-a', '查日志', first.executor)

    watch.rebind(second.executor)
    watch.holdStarted()

    expect(first.steps).toHaveLength(0)
    expect(second.steps).toHaveLength(1)
    expect(second.steps[0].content).toContain('0')
    watch.release()
  })
})
