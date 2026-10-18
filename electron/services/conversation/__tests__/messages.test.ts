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
  chunkStepsForCompanionExtract,
  stepRecordToStep,
  restoreSpokenRepliesMissingFromMessages
} from '../messages'
import type { AgentStep } from '@shared/types'

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

describe('messages.chunkStepsForCompanionExtract', () => {
  const step = (id: string, type: AgentStep['type']): AgentStep => ({ id, type, content: id, timestamp: 0 })
  const ids = (chunks: AgentStep[][]) => chunks.map(c => c.map(s => s.id))

  it('结束后的回执那一轮单独成段，它送出的那句话留在段内', () => {
    const chunks = chunkStepsForCompanionExtract([
      step('u1', 'user_task'), step('f1', 'final_result'),
      step('r', 'task_receipt'), step('call', 'tool_call'), step('said', 'proactive_notice'), step('fr', 'final_result'),
      step('n', 'proactive_notice'),
      step('u2', 'user_task'),
    ])
    expect(ids(chunks)).toEqual([['u1', 'f1'], ['r', 'call', 'said', 'fr'], ['n'], ['u2']])
  })

  it('进行中的一轮里插进来的回执不另起段', () => {
    const chunks = chunkStepsForCompanionExtract([
      step('u1', 'user_task'), step('r', 'task_receipt'), step('f1', 'final_result'),
    ])
    expect(ids(chunks)).toEqual([['u1', 'r', 'f1']])
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

  it('透传扫描版 PDF 的页面图，且不和用户自己的图混在一起', () => {
    const rec = {
      id: 's3',
      type: 'user_task',
      content: '看这份',
      timestamp: 1,
      images: ['user-img'],
      docPreviewImages: ['page-1', 'page-2'],
    } as any
    const step = stepRecordToStep(rec)
    expect(step.images).toEqual(['user-img'])
    expect(step.docPreviewImages).toEqual(['page-1', 'page-2'])
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

describe('messages.restoreSpokenRepliesMissingFromMessages', () => {
  const partial = '收到，来一次真正的深度测试。派 5 个伙计并行开工，分工如下：'
  const stopped = '行，那就停在这，不动手了。'

  function interruptedRecord() {
    const messages: AiMessage[] = [
      { role: 'user', content: '<sf_user_message>深度测试下</sf_user_message>' },
      { role: 'user', content: '<sf_user_message>算了不做了</sf_user_message>', _systemInjected: true },
      { role: 'assistant', content: stopped },
      { role: 'user', content: '<sf_user_message>等一下，你刚才是打算深度测试什么东西？</sf_user_message>' },
      { role: 'assistant', content: '那个「5」是从以前的对话里读到的，这场没提过数字。' }
    ]
    const steps = [
      { type: 'user_task', content: '深度测试下' },
      { type: 'message', content: `<details><summary>思考</summary>\n\n内部草稿\n</details>\n\n${partial}` },
      { type: 'tool_call', content: '派出 1 个伙计 · 160 字符' },
      { type: 'user_supplement', content: '算了不做了' },
      { type: 'message', content: `<details><summary>思考</summary>\n\n再想\n</details>\n\n${stopped}` },
      { type: 'final_result', content: stopped },
      { type: 'user_task', content: '等一下，你刚才是打算深度测试什么东西？' },
      { type: 'message', content: '那个「5」是从以前的对话里读到的，这场没提过数字。' },
      { type: 'final_result', content: '那个「5」是从以前的对话里读到的，这场没提过数字。' }
    ]
    return { messages, steps }
  }

  it('把屏幕上有、记录里没有的半截回复补到插话前面，思考块不带上', () => {
    const { messages, steps } = interruptedRecord()
    const restored = restoreSpokenRepliesMissingFromMessages(messages, steps)
    expect(restored.map(m => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant'
    ])
    expect(restored[1].content).toBe(partial)
    expect(restored[1].content).not.toContain('内部草稿')
    expect(restored[2].content).toContain('算了不做了')
    expect(restored[3].content).toBe(stopped)
  })

  it('再补一次不重复', () => {
    const { messages, steps } = interruptedRecord()
    const once = restoreSpokenRepliesMissingFromMessages(messages, steps)
    const twice = restoreSpokenRepliesMissingFromMessages(once, steps)
    expect(twice).toEqual(once)
  })

  it('回复已经在记录里时不另加一条', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: 'Task 1 question' },
      { role: 'assistant', content: 'Task 1 answer' }
    ]
    const steps = [
      { type: 'user_task', content: 'Task 1 question' },
      { type: 'message', content: '<details><summary>思考</summary>想</details>\n\nTask 1 answer' },
      { type: 'final_result', content: 'Task 1 answer' }
    ]
    const restored = restoreSpokenRepliesMissingFromMessages(messages, steps)
    expect(restored.map(m => m.content)).toEqual(['Task 1 question', 'Task 1 answer'])
  })

  it('不把半截回复插进工具调用和结果中间', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: '跑一下' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
      { role: 'assistant', content: '跑完了' }
    ]
    const steps = [
      { type: 'user_task', content: '跑一下' },
      { type: 'message', content: '先看一眼环境' },
      { type: 'tool_call', content: 'exec' },
      { type: 'tool_result', content: 'ok' },
      { type: 'message', content: '跑完了' },
      { type: 'final_result', content: '跑完了' }
    ]
    const restored = restoreSpokenRepliesMissingFromMessages(messages, steps)
    const toolAt = restored.findIndex(m => m.role === 'tool')
    expect(restored[toolAt - 1].tool_calls?.[0].id).toBe('c1')
    expect(restored.map(m => m.role)).toEqual(['user', 'assistant', 'assistant', 'tool', 'assistant'])
    expect(restored[1].content).toBe('先看一眼环境')
  })
})
