import { describe, expect, it } from 'vitest'
import type { AgentStep } from '@shared/types'
import { findTaskCompleteFooterIndex, groupAgentSteps, groupNeedsProcessCompleteFooter } from './agent-task-groups'

let seq = 0
function step(partial: Partial<AgentStep> & Pick<AgentStep, 'type' | 'content'>): AgentStep {
  seq += 1
  return {
    id: partial.id ?? `s${seq}`,
    timestamp: seq * 1000,
    ...partial,
  }
}

describe('groupAgentSteps', () => {
  it('puts a user-requested compact after the ended task as a new turn', () => {
    const { groups } = groupAgentSteps([
      step({ type: 'user_task', content: '说个任务' }),
      step({ type: 'error', content: '上下文超出模型限制' }),
      step({ type: 'final_result', content: '❌ 任务失败' }),
      step({ id: 'compact-user', type: 'user_task', content: '压缩上下文' }),
      step({ id: 'compact-think', type: 'thinking', content: '正在压缩上下文' }),
      step({ id: 'compact-tool', type: 'tool_call', content: '压缩上下文', toolName: 'compress_context' }),
      step({ type: 'final_result', content: '已压缩' }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].userTask).toBe('说个任务')
    expect(groups[0].finalResult).toBe('❌ 任务失败')
    expect(groups[0].afterEndSteps).toEqual([])
    expect(groups[1].userTask).toBe('压缩上下文')
    expect(groups[1].steps.map(s => s.id)).toEqual(['compact-think', 'compact-tool'])
    expect(groups[1].finalResult).toBe('已压缩')
  })

  it('keeps in-task compact inside the running task', () => {
    const { groups } = groupAgentSteps([
      step({ type: 'user_task', content: '继续' }),
      step({ id: 'mid-compact', type: 'tool_call', content: '压缩上下文', toolName: 'compress_context' }),
      step({ type: 'message', content: '接着做' }),
    ])

    expect(groups[0].steps.map(s => s.id)).toEqual(['mid-compact', groups[0].steps[1].id])
    expect(groups[0].afterEndSteps).toEqual([])
  })

  it('keeps orphan post-task process after the ended task, not inside it', () => {
    const { groups } = groupAgentSteps([
      step({ type: 'user_task', content: '先做完' }),
      step({ type: 'message', content: '好了' }),
      step({ type: 'final_result', content: '完成' }),
      step({ type: 'thinking', content: '正在压缩上下文' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].userTask).toBe('先做完')
    expect(groups[0].afterEndSteps).toHaveLength(1)
  })

  it('a receipt arriving while idle starts its own turn that nobody asked for', () => {
    const { groups } = groupAgentSteps([
      step({ type: 'user_task', content: '帮我订会议室' }),
      step({ type: 'final_result', content: '交给任务了' }),
      step({ id: 'r', type: 'task_receipt', content: '任务回执：已完成' }),
      step({ id: 'say', type: 'tool_call', content: '告诉用户', toolName: 'talk_to_user' }),
      step({ type: 'final_result', content: '已转告' }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[1].isReceipt).toBe(true)
    expect(groups[1].userTask).toBe('')
    expect(groups[1].steps.map(s => s.id)).toEqual(['r', 'say'])
    expect(groups[1].finalResult).toBe('已转告')
  })

  it('a receipt taken in mid-turn stays inside that turn', () => {
    const { groups } = groupAgentSteps([
      step({ type: 'user_task', content: '帮我订会议室' }),
      step({ id: 'r', type: 'task_receipt', content: '任务回执：已完成' }),
      step({ type: 'message', content: '订好了' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].isReceipt).toBeUndefined()
    expect(groups[0].steps[0].id).toBe('r')
  })
})

describe('groupNeedsProcessCompleteFooter', () => {
  it('is true when a successful turn never spoke', () => {
    expect(groupNeedsProcessCompleteFooter({
      finalResult: '上下文已压缩',
    })).toBe(true)
  })

  it('is true when it already said something', () => {
    expect(groupNeedsProcessCompleteFooter({
      finalResult: '好了',
    })).toBe(true)
  })

  it('is false for a failed turn', () => {
    expect(groupNeedsProcessCompleteFooter({
      finalResult: '❌ 任务失败',
    })).toBe(false)
  })
})

describe('findTaskCompleteFooterIndex', () => {
  const group = { id: 'g' }

  it('hangs the mark on the last cell, not an earlier sentence', () => {
    const items = [
      { type: 'user_task', group },
      { type: 'step', group },
      { type: 'folded_turn', group },
    ]
    expect(findTaskCompleteFooterIndex(items, 'g')).toBe(2)
  })

  it('hangs the mark on the sentence when nothing follows it', () => {
    const items = [
      { type: 'folded_turn', group },
      { type: 'step', group },
    ]
    expect(findTaskCompleteFooterIndex(items, 'g')).toBe(1)
  })

  it('does not pick another turn', () => {
    const items = [
      { type: 'step', group },
      { type: 'step', group: { id: 'other' } },
    ]
    expect(findTaskCompleteFooterIndex(items, 'g')).toBe(0)
  })
})
