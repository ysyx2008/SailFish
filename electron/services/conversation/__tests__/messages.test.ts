/**
 * messages.ts 纯切分函数单测
 *
 * 这是 Agent 与 Conversation 共用的「唯一权威切分实现」，此处直接钉其纯函数行为：
 * 真实 user 边界 vs `_systemInjected`、steps 降级路径、按 user_task 分 chunk、record→step 转换。
 * 防止将来误改这一份实现而同时悄悄破坏两个调用方。
 */
import { describe, it, expect } from 'vitest'
import type { AgentStepRecord } from '@shared/types'
import type { AiMessage } from '../../ai.service'
import {
  splitMessagesIntoTasks,
  splitStepsIntoTasks,
  chunkStepsByUserTask,
  stepRecordToStep
} from '../messages'

const idByIndex = (i: number) => `t_${i}`

describe('messages.splitMessagesIntoTasks', () => {
  it('按真实 user 边界切分，_systemInjected 的 user 消息并入当前任务、不另起', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: '任务一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '图片占位', _systemInjected: true },
      { role: 'assistant', content: '答一续' },
      { role: 'user', content: '任务二' },
      { role: 'assistant', content: '答二' }
    ]
    const tasks = splitMessagesIntoTasks(messages, idByIndex)
    expect(tasks.length).toBe(2)
    expect(tasks[0].messages.length).toBe(4)
    expect(tasks[0].userTask).toBe('任务一')
    expect(tasks[0].finalResult).toBe('答一续')
    expect(tasks[1].messages.length).toBe(2)
    expect(tasks[1].userTask).toBe('任务二')
  })

  it('finalResult 取最后一条无 tool_calls 的 assistant（带 tool_calls 的不算最终回复）', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: '任务' },
      { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }] as any },
      { role: 'tool', content: 'ok', tool_call_id: '1' } as any,
      { role: 'assistant', content: '完成了' }
    ]
    const tasks = splitMessagesIntoTasks(messages, idByIndex)
    expect(tasks.length).toBe(1)
    expect(tasks[0].finalResult).toBe('完成了')
  })

  it('makeId 接收即将 push 的任务下标（push 前的 tasks.length）', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ]
    const tasks = splitMessagesIntoTasks(messages, i => `id-${i}`)
    expect(tasks.map(t => t.id)).toEqual(['id-0', 'id-1'])
  })

  it('空输入返回空数组', () => {
    expect(splitMessagesIntoTasks([], idByIndex)).toEqual([])
  })
})

describe('messages.splitStepsIntoTasks', () => {
  const mkStep = (over: Partial<AgentStepRecord>): AgentStepRecord => ({
    id: Math.random().toString(36).slice(2),
    type: 'thinking',
    content: '',
    timestamp: Date.now(),
    ...over
  }) as AgentStepRecord

  it('按 user_task 切分，final_result 作为任务结果', () => {
    const steps: AgentStepRecord[] = [
      mkStep({ type: 'user_task', content: '任务一' }),
      mkStep({ type: 'final_result', content: '结果一' }),
      mkStep({ type: 'user_task', content: '任务二' }),
      mkStep({ type: 'final_result', content: '结果二' })
    ]
    const tasks = splitStepsIntoTasks(steps, idByIndex)
    expect(tasks.length).toBe(2)
    expect(tasks[0].userTask).toBe('任务一')
    expect(tasks[0].finalResult).toBe('结果一')
    expect(tasks[1].userTask).toBe('任务二')
    expect(tasks[1].finalResult).toBe('结果二')
  })

  it('无 user_task 不产出任务', () => {
    const tasks = splitStepsIntoTasks([mkStep({ type: 'thinking', content: 'x' })], idByIndex)
    expect(tasks.length).toBe(0)
  })

  it('空输入返回空数组', () => {
    expect(splitStepsIntoTasks([], idByIndex)).toEqual([])
  })
})

describe('messages.chunkStepsByUserTask', () => {
  const mk = (type: string, content = ''): any => ({ id: content || type, type, content, timestamp: 0 })

  it('每个 chunk 以 user_task 开头', () => {
    const steps = [
      mk('user_task', 'a'), mk('thinking'), mk('final_result', 'ra'),
      mk('user_task', 'b'), mk('final_result', 'rb')
    ]
    const chunks = chunkStepsByUserTask(steps as any)
    expect(chunks.length).toBe(2)
    expect(chunks[0].length).toBe(3)
    expect(chunks[1].length).toBe(2)
    expect(chunks[0][0].type).toBe('user_task')
    expect(chunks[1][0].type).toBe('user_task')
  })

  it('空输入返回空数组', () => {
    expect(chunkStepsByUserTask([])).toEqual([])
  })
})

describe('messages.stepRecordToStep', () => {
  it('透传富内容字段（images / subAgents / canvasData 等）', () => {
    const rec = {
      id: 's1',
      type: 'tool_result',
      content: 'c',
      timestamp: 123,
      images: ['img'],
      subAgents: [{ id: 'a' }],
      canvasData: { kind: 'x' },
      success: true,
      toolName: 'shell'
    } as any
    const step = stepRecordToStep(rec)
    expect(step.id).toBe('s1')
    expect(step.type).toBe('tool_result')
    expect(step.images).toEqual(['img'])
    expect(step.subAgents).toEqual([{ id: 'a' }])
    expect(step.canvasData).toEqual({ kind: 'x' })
    expect(step.success).toBe(true)
    expect(step.toolName).toBe('shell')
  })

  it('透传提问回答和替我审批留痕', () => {
    const rec = {
      id: 's2',
      type: 'auto_review',
      content: '替你放行',
      timestamp: 1,
      askingStatus: 'received',
      askingAnswer: '确定删',
      autoReview: { outcome: 'approved', risk: 'high', authorization: 'high', rationale: '你说了' },
    } as any
    const step = stepRecordToStep(rec)
    expect(step.askingAnswer).toBe('确定删')
    expect(step.autoReview).toEqual(rec.autoReview)
  })
})
