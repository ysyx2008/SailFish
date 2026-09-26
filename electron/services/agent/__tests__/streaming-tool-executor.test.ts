import { describe, it, expect, vi } from 'vitest'
import { StreamingToolExecutor } from '../streaming-tool-executor'
import type { AgentRun } from '../types'
import type { ToolCall } from '../../ai.service'

function makeToolCall(id: string, name = 'read_file'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: '{"path":"/tmp/a.txt"}' },
  }
}

function createRun(): AgentRun {
  return {
    id: 'run-1',
    messages: [],
    taskMessageLog: [],
    steps: [],
    aborted: false,
    context: {},
  } as unknown as AgentRun
}

describe('StreamingToolExecutor parallelShare', () => {
  it('passes parallelShare=1 for a single concurrency-safe tool', async () => {
    const shares: number[] = []
    const executor = new StreamingToolExecutor({
      run: createRun(),
      availableToolNames: new Set(['read_file']),
      isConcurrencySafe: () => true,
      executeFn: async (_tc, opts) => {
        shares.push(opts?.parallelShare ?? 0)
        return { result: { success: true, output: 'ok' }, toolArgs: {} }
      },
    })

    executor.addTool(makeToolCall('tc1'))
    await executor.waitForAll()

    expect(shares).toEqual([1])
  })

  it('passes parallelShare=N when N safe tools are queued before any completes', async () => {
    const shares: number[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })

    const executor = new StreamingToolExecutor({
      run: createRun(),
      availableToolNames: new Set(['read_file']),
      isConcurrencySafe: () => true,
      executeFn: async (tc, opts) => {
        shares.push(opts?.parallelShare ?? 0)
        if (tc.id === 'tc1') await firstGate
        return { result: { success: true, output: tc.id }, toolArgs: {} }
      },
    })

    executor.addTool(makeToolCall('tc1'))
    executor.addTool(makeToolCall('tc2'))
    executor.addTool(makeToolCall('tc3'))

    await vi.waitFor(() => {
      expect(shares.length).toBeGreaterThanOrEqual(1)
    })

    releaseFirst()
    await executor.waitForAll()
    expect(shares).toEqual([3, 3, 3])
  })

  it('does not count unsafe tools in parallelShare for safe tools', async () => {
    const shares: number[] = []
    let releaseUnsafe!: () => void
    const unsafeGate = new Promise<void>(resolve => {
      releaseUnsafe = resolve
    })

    const executor = new StreamingToolExecutor({
      run: createRun(),
      availableToolNames: new Set(['read_file', 'edit_file']),
      isConcurrencySafe: (name) => name === 'read_file',
      executeFn: async (tc, opts) => {
        if (tc.function.name === 'read_file') {
          shares.push(opts?.parallelShare ?? 0)
        }
        if (tc.function.name === 'edit_file') await unsafeGate
        return { result: { success: true, output: tc.id }, toolArgs: {} }
      },
    })

    executor.addTool(makeToolCall('unsafe', 'edit_file'))
    executor.addTool(makeToolCall('safe1'))
    executor.addTool(makeToolCall('safe2'))

    await vi.waitFor(() => {
      expect(shares.length).toBe(0)
    })

    releaseUnsafe()
    await executor.waitForAll()

    expect(shares).toEqual([2, 2])
  })

  it('caps parallelShare by maxConcurrency when more safe tools are queued', async () => {
    const shares: number[] = []
    const gates = new Map<string, { promise: Promise<void>; release: () => void }>()
    const makeGate = (id: string) => {
      let release!: () => void
      const promise = new Promise<void>(resolve => {
        release = resolve
      })
      gates.set(id, { promise, release })
    }

    const executor = new StreamingToolExecutor({
      run: createRun(),
      availableToolNames: new Set(['read_file']),
      isConcurrencySafe: () => true,
      maxConcurrency: 2,
      executeFn: async (tc, opts) => {
        shares.push(opts?.parallelShare ?? 0)
        const gate = gates.get(tc.id)
        if (gate) await gate.promise
        return { result: { success: true, output: tc.id }, toolArgs: {} }
      },
    })

    makeGate('tc1')
    makeGate('tc2')

    executor.addTool(makeToolCall('tc1'))
    executor.addTool(makeToolCall('tc2'))
    executor.addTool(makeToolCall('tc3'))

    await vi.waitFor(() => {
      expect(shares).toEqual([2, 2])
    })

    gates.get('tc1')!.release()

    await vi.waitFor(() => {
      expect(shares).toEqual([2, 2, 2])
    })

    gates.get('tc2')!.release()
    await executor.waitForAll()
  })
})

describe('StreamingToolExecutor abort', () => {
  it('abort 把排队中的工具标为已中止，waitForAll 仍等正在执行的收尾', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const completed: string[] = []

    const executor = new StreamingToolExecutor({
      run: createRun(),
      availableToolNames: new Set(['read_file']),
      isConcurrencySafe: () => true,
      maxConcurrency: 1,
      executeFn: async (tc) => {
        if (tc.id === 'tc1') await firstGate
        return { result: { success: true, output: tc.id }, toolArgs: {} }
      },
      onToolCompleted: ({ toolCall }) => {
        completed.push(toolCall.id)
      },
    })

    executor.addTool(makeToolCall('tc1'))
    executor.addTool(makeToolCall('tc2'))

    await vi.waitFor(() => {
      expect(completed.length).toBe(0)
    })

    executor.abort()
    releaseFirst()
    const results = await executor.waitForAll()

    expect(results).toHaveLength(2)
    expect(results[0].result.success).toBe(true)
    expect(results[1].result.success).toBe(false)
    expect(results[1].result.error).toMatch(/中止|abort/i)
    expect(completed).toContain('tc2')
  })
})
