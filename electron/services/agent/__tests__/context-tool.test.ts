import { describe, expect, it, vi } from 'vitest'
import type { AgentStep } from '@shared/types'
import { checkContext, compressContext, dispatchContext, recallCompressed, resolveContextAction } from '../tools/context'
import type { ToolExecutorConfig } from '../tools/types'

function makeExecutor(overrides?: Partial<ToolExecutorConfig>): ToolExecutorConfig & { steps: AgentStep[] } {
  const steps: AgentStep[] = []
  return {
    steps,
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
  } as ToolExecutorConfig & { steps: AgentStep[] }
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
    const visible = executor.steps.map(step => `${step.content ?? ''}\n${step.toolResult ?? ''}`).join('\n')
    expect(visible).not.toContain('ca-1')

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

describe('recall 取归档：一览只露开头，单条能取全文', () => {
  const longText = Array.from({ length: 60 }, (_, i) => `R${i * 100}:${'字'.repeat(95)}`).join('')
  const longArgs = JSON.stringify({ path: 'a.md', content: 'W'.repeat(900) + 'ARGS_TAIL' })
  const archive = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_text_file', arguments: longArgs } }] },
    { role: 'tool', content: `${'o'.repeat(45000)}TOOL_TAIL`, tool_call_id: 'c1' },
    { role: 'assistant', content: `${longText}TEXT_TAIL` },
    { role: 'assistant', content: '短内容原样在' }
  ]
  const exec = () => makeExecutor({
    getCompressedArchive: (id: string) => (id === 'ca-1' ? (archive as never) : null)
  })

  it('一览：长的只露开头并写明总长与取全文的办法，短的原样', () => {
    const out = recallCompressed({ archive_id: 'ca-1' }, exec()).output
    expect(out).not.toContain('TOOL_TAIL')
    expect(out).not.toContain('TEXT_TAIL')
    expect(out).toContain('message_index: 2')
    expect(out).toContain(`content total ${longText.length + 'TEXT_TAIL'.length} chars`)
    expect(out).toContain('短内容原样在')
  })

  it('单取一条：正文、工具输出、工具入参的结尾都在', () => {
    const e = exec()
    expect(recallCompressed({ archive_id: 'ca-1', message_index: 3 }, e).output).toContain('短内容原样在')
    expect(recallCompressed({ archive_id: 'ca-1', message_index: 2 }, e).output).toContain('TEXT_TAIL')
    expect(recallCompressed({ archive_id: 'ca-1', message_index: 0 }, e).output).toContain('ARGS_TAIL')
  })

  it('超过一页的用 offset 接着读，拼起来不缺字', () => {
    const e = exec()
    const first = recallCompressed({ archive_id: 'ca-1', message_index: 1 }, e).output
    expect(first).not.toContain('TOOL_TAIL')
    const next = /offset: (\d+)/.exec(first)
    expect(next).not.toBeNull()
    const second = recallCompressed({ archive_id: 'ca-1', message_index: 1, offset: Number(next![1]) }, e).output
    const third = /offset: (\d+)/.exec(second)
    const last = recallCompressed({ archive_id: 'ca-1', message_index: 1, offset: Number(third![1]) }, e).output
    expect(last).toContain('TOOL_TAIL')
    expect(last).not.toContain('continue:')
  })

  it('offset 超过全文长度时报错并说明总长，不返回空页', () => {
    const r = recallCompressed({ archive_id: 'ca-1', message_index: 3, offset: 99999 }, exec())
    expect(r.success).toBe(false)
    expect(r.error).toContain('99999')
    expect(r.error).toContain(String('短内容原样在'.length))
  })

  it('序号超出时报错并说明条数', () => {
    const r = recallCompressed({ archive_id: 'ca-1', message_index: 9 }, exec())
    expect(r.success).toBe(false)
    expect(r.error).toContain('4')
  })
})
