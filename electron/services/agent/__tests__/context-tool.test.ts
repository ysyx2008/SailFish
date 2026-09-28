import { describe, expect, it, vi } from 'vitest'
import type { AgentStep } from '@shared/types'
import { checkContext, compressContext, dispatchContext, resolveContextAction } from '../tools/context'
import type { ToolExecutorConfig } from '../tools/types'

function makeExecutor(overrides?: Partial<ToolExecutorConfig>): ToolExecutorConfig {
  const steps: AgentStep[] = []
  return {
    addStep: (step) => {
      const created = { id: `s${steps.length}`, timestamp: Date.now(), ...step } as AgentStep
      steps.push(created)
      return created
    },
    updateStep: vi.fn(),
    removeStep: vi.fn(),
    getContextUsage: () => ({ used: 12_000, total: 128_000, remaining: 116_000 }),
    compressCurrentContext: vi.fn().mockResolvedValue({
      beforeTokens: 20_000,
      afterTokens: 8_000,
      freedTokens: 12_000,
      archiveId: 'ca-1',
      keepRecent: 4
    }),
    ...overrides
  } as ToolExecutorConfig
}

describe('dispatchContext', () => {
  it('check 或省略 action 时只报数', async () => {
    const executor = makeExecutor()
    const checked = await dispatchContext({ action: 'check' }, executor)
    expect(checked.success).toBe(true)
    expect(checked.output).toContain('12,000')
    expect(checked.output).not.toContain('该压缩')

    const implicit = await dispatchContext({}, makeExecutor())
    expect(implicit.success).toBe(true)
    expect(implicit.output).toContain('116,000')
  })

  it('compress 或只带 summary 时走压缩，summary 只当作要重点留下的补充', async () => {
    const executor = makeExecutor()
    const result = await dispatchContext({
      action: 'compress',
      summary: '重点留部署步骤'
    }, executor)
    expect(result.success).toBe(true)
    expect(executor.compressCurrentContext).toHaveBeenCalledWith('重点留部署步骤')
    expect(result.output).toContain('ca-1')

    const inferred = makeExecutor()
    const inferredResult = await dispatchContext({ summary: '只带小结也当压缩' }, inferred)
    expect(inferredResult.success).toBe(true)
    expect(inferred.compressCurrentContext).toHaveBeenCalledWith('只带小结也当压缩')
  })

  it('不写 summary 也能压', async () => {
    const executor = makeExecutor()
    const result = await dispatchContext({ action: 'compress' }, executor)
    expect(result.success).toBe(true)
    expect(executor.compressCurrentContext).toHaveBeenCalledWith(undefined)
  })

  it('未知 action 报错', async () => {
    const result = await dispatchContext({ action: 'wipe' }, makeExecutor())
    expect(result.success).toBe(false)
    expect(result.error).toContain('wipe')
  })

  it('action 大小写不敏感', () => {
    expect(resolveContextAction({ action: 'Compress', summary: '交接' })).toBe('compress')
  })
})

describe('旧工具名仍可用', () => {
  it('checkContext / compressContext 各自还能单独调用', async () => {
    expect(checkContext(makeExecutor()).success).toBe(true)
    expect((await compressContext({ summary: '交接' }, makeExecutor())).success).toBe(true)
  })
})
