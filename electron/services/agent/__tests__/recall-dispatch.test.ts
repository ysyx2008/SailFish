import { describe, expect, it, vi } from 'vitest'
import { dispatchRecall } from '../tools/memory'
import { executeTool } from '../tools/index'
import type { AgentConfig, ToolExecutorConfig } from '../tools/types'

function makeExecutor(overrides?: Partial<ToolExecutorConfig>): ToolExecutorConfig {
  return {
    isAborted: () => false,
    addStep: vi.fn(),
    getTaskMemory: () => ({
      getSummaries: () => [{ id: 't1', summary: '查 nginx', status: 'success', timestamp: 1 }],
      getDigest: () => ({
        userRequest: '查 nginx',
        digest: { commands: ['nginx -t'], paths: ['/etc/nginx'], services: [], errors: [], keyFindings: ['ok'] }
      }),
      getFullSteps: () => []
    }),
    getCompressedArchives: () => [
      { id: 'ca-1', summary: '前半截探查', messageCount: 4, timestamp: 2 }
    ],
    getCompressedArchive: (id: string) => (
      id === 'ca-1' ? [{ role: 'assistant', content: '探过了' }] : null
    ),
    ...overrides
  } as unknown as ToolExecutorConfig
}

describe('dispatchRecall', () => {
  it('不带号时列出任务和归档', () => {
    const result = dispatchRecall({}, makeExecutor(), undefined)
    expect(result.success).toBe(true)
    expect(result.output).toContain('[t1]')
    expect(result.output).toContain('ca-1')
    expect(result.output).toContain('task_id')
    expect(result.output).toContain('archive_id')
  })

  it('两个号都给则报错，不取任何一边', () => {
    const getCompressedArchive = vi.fn()
    const result = dispatchRecall(
      { task_id: 't1', archive_id: 'ca-1' },
      makeExecutor({ getCompressedArchive }),
      undefined
    )
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    expect(getCompressedArchive).not.toHaveBeenCalled()
  })

  it('只给归档号则取原文', () => {
    const result = dispatchRecall({ archive_id: 'ca-1' }, makeExecutor(), undefined)
    expect(result.success).toBe(true)
    expect(result.output).toContain('探过了')
    expect(result.output).toContain('ca-1')
  })

  it('只给任务号则取摘要', () => {
    const result = dispatchRecall({ task_id: 't1' }, makeExecutor(), undefined)
    expect(result.success).toBe(true)
    expect(result.output).toContain('nginx -t')
    expect(result.output).toContain('/etc/nginx')
  })

  it('这场什么都没有时列出空，不当失败', () => {
    const result = dispatchRecall({}, makeExecutor({
      getTaskMemory: () => ({ getSummaries: () => [] } as never),
      getCompressedArchives: () => []
    }), undefined)
    expect(result.success).toBe(true)
    expect(result.output).toBeTruthy()
  })

  it('task_id 带空格会 trim 后再查', () => {
    const getDigest = vi.fn(() => ({
      userRequest: '查 nginx',
      digest: { commands: ['nginx -t'], paths: [], services: [], errors: [], keyFindings: [] }
    }))
    const result = dispatchRecall({ task_id: ' t1 ' }, makeExecutor({
      getTaskMemory: () => ({
        getSummaries: () => [],
        getDigest,
        getFullSteps: () => []
      } as never)
    }), undefined)
    expect(getDigest).toHaveBeenCalledWith('t1')
    expect(result.success).toBe(true)
  })

  it('detail=full 仍走完整步骤', () => {
    const getFullSteps = vi.fn(() => [
      { type: 'thinking', content: '先看配置' }
    ])
    const result = dispatchRecall({ task_id: 't1', detail: 'full' }, makeExecutor({
      getTaskMemory: () => ({
        getSummaries: () => [],
        getDigest: () => null,
        getFullSteps
      } as never)
    }), undefined)
    expect(getFullSteps).toHaveBeenCalledWith('t1', undefined)
    expect(result.success).toBe(true)
    expect(result.output).toContain('先看配置')
  })

  it('旧名 recall_compressed 仍能取归档', async () => {
    const result = await executeTool(
      undefined,
      {
        id: 'c1',
        type: 'function',
        function: { name: 'recall_compressed', arguments: JSON.stringify({ archive_id: 'ca-1' }) }
      },
      {} as AgentConfig,
      [],
      makeExecutor()
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('探过了')
  })

  it('伙计不能取归档', () => {
    const getCompressedArchive = vi.fn()
    const result = dispatchRecall(
      { archive_id: 'ca-1' },
      makeExecutor({ isSubAgent: true, getCompressedArchive }),
      undefined
    )
    expect(result.success).toBe(false)
    expect(getCompressedArchive).not.toHaveBeenCalled()
  })
})
