/**
 * 联络「从这里创建任务」：AI 挑选相关对话
 *
 * 覆盖：
 *  - CompanionSeedPicker：说明编号、回复解析（严格、越界忽略、终点不依赖回复）
 *  - Conversation：按挑选抽取（整段进出、前置提醒、终点之后不带）、候选列表
 *  - AgentService.extractTaskFromCompanion：热前缀（接在联络对话后问）/ 冷（只发简述）/ 失败回退时间窗口
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { AgentService } from '../index'
import { updateLocale } from '../i18n'
import { Conversation } from '../../conversation'
import { CompanionSeedPicker, createThinkingFeed, thinkingPreview } from '../../conversation/companion-seed'
import type { CompanionPickCandidate } from '../../conversation/conversation'
import type { AiMessage } from '../../ai.service'
import type { AgentRecord, AgentStepRecord } from '@shared/types'

// 断言里是中文文案，固定语言，免得被同进程其它测试切到英文
beforeAll(() => updateLocale('zh-CN'))

const T0 = new Date('2026-10-09T10:00:00').getTime()
const MIN = 60 * 1000

/** 一段用户对话：user_task + final_result */
function userChunk(id: string, text: string, offsetMin: number, result = `答${text}`): AgentStepRecord[] {
  const ts = T0 + offsetMin * MIN
  return [
    { id: `ut_${id}`, type: 'user_task', content: text, timestamp: ts },
    { id: `fr_${id}`, type: 'final_result', content: result, timestamp: ts + 100 }
  ]
}

/** 一条主动提醒（和联络里 proactive 记录同形：user_task='__proactive__'） */
function proactiveChunk(id: string, offsetMin: number): AgentStepRecord[] {
  const ts = T0 + offsetMin * MIN
  return [
    { id: `ut_${id}`, type: 'user_task', content: '__proactive__', timestamp: ts },
    { id: `fr_${id}`, type: 'final_result', content: `通知${id}`, timestamp: ts + 100 }
  ]
}

function record(id: string, steps: AgentStepRecord[], messages: AiMessage[], proactive = false): AgentRecord {
  return {
    id,
    kind: 'companion',
    timestamp: steps[0].timestamp,
    terminalId: '',
    agentKey: '__companion__',
    terminalType: 'assistant',
    userTask: proactive ? '__proactive__' : steps[0].content,
    steps,
    messages,
    duration: 0,
    status: 'completed'
  }
}

/** A(0) B(10) [p](11) C(12) D(13) E(14)；每段一条记录，messages 与 steps 对齐 */
function sixRecords(): AgentRecord[] {
  const real = (id: string, offset: number) =>
    record(`sess_${id}`, userChunk(id, id.toUpperCase(), offset), [
      { role: 'user', content: id.toUpperCase() },
      { role: 'assistant', content: `答${id.toUpperCase()}` }
    ])
  return [
    real('a', 0),
    real('b', 10),
    record('sess_p', proactiveChunk('p', 11), [], true),
    real('c', 12),
    real('d', 13),
    real('e', 14)
  ]
}

describe('CompanionSeedPicker', () => {
  const candidates: CompanionPickCandidate[] = [
    { stepId: 'ut_a', timestamp: T0, userText: '帮我查一下发票', resultText: '查到了' },
    { stepId: 'ut_b', timestamp: T0 + 10 * MIN, userText: '今天天气', resultText: '' },
    { stepId: 'ut_c', timestamp: T0 + 20 * MIN, userText: '把发票发给财务', resultText: '已发送' }
  ]

  it('说明里按时间编号，终点是最大序号，简述含用户话和结果', () => {
    const text = new CompanionSeedPicker(candidates).buildInstruction()
    expect(text).toContain('1. [10-09 10:00] 用户：帮我查一下发票 → 结果：查到了')
    expect(text).toContain('2. [10-09 10:10] 用户：今天天气')
    expect(text).not.toContain('2. [10-09 10:10] 用户：今天天气 →')
    expect(text).toContain('3. [10-09 10:20] 用户：把发票发给财务 → 结果：已发送')
    expect(text).toContain('第 3 段')
  })

  it('简述单行、过长截断', () => {
    const long = 'x'.repeat(200)
    const text = new CompanionSeedPicker([
      { stepId: 'ut_a', timestamp: T0, userText: `头\n尾${long}`, resultText: '' },
      { stepId: 'ut_b', timestamp: T0, userText: 'b', resultText: '' }
    ]).buildInstruction()
    expect(text).toContain('用户：头 尾')
    expect(text).toContain('…')
    expect(text).not.toContain('x'.repeat(100))
  })

  it('候选超过上限时只保留最靠近终点的那些，序号重新从 1 排', () => {
    const many: CompanionPickCandidate[] = Array.from({ length: CompanionSeedPicker.MAX_CANDIDATES + 5 }, (_, i) => ({
      stepId: `ut_${i}`,
      timestamp: T0 + i * MIN,
      userText: `话${i}`,
      resultText: ''
    }))
    const picker = new CompanionSeedPicker(many)
    const text = picker.buildInstruction()
    expect(text).not.toContain('用户：话0\n')
    expect(text).toContain(`${CompanionSeedPicker.MAX_CANDIDATES}. `)
    // 序号 1 对应被保留的第一条（原下标 5）
    expect(picker.parseReply('1')).toEqual(['ut_5'])
  })

  it('回复解析：序号还原成 step id，升序去重，越界忽略', () => {
    const picker = new CompanionSeedPicker(candidates)
    expect(picker.parseReply('1, 3')).toEqual(['ut_a', 'ut_c'])
    expect(picker.parseReply('3,1,1')).toEqual(['ut_a', 'ut_c'])
    expect(picker.parseReply('1，3')).toEqual(['ut_a', 'ut_c'])
    expect(picker.parseReply('2, 9, 0')).toEqual(['ut_b'])
  })

  it('回复里夹着别的文字 / 为空 / 没有有效序号 → null（交给调用方回退）', () => {
    const picker = new CompanionSeedPicker(candidates)
    expect(picker.parseReply('选 1 和 3')).toBeNull()
    expect(picker.parseReply('1,3 因为相关')).toBeNull()
    expect(picker.parseReply('')).toBeNull()
    expect(picker.parseReply(null)).toBeNull()
    expect(picker.parseReply('9, 10')).toBeNull()
  })
})

describe('Conversation 按挑选抽取', () => {
  it('候选：锚点之前的各段用户对话，最后一项是锚点；不含锚点之后、不含主动提醒', () => {
    const list = Conversation.listCompanionPickCandidates(sixRecords(), { anchorTaskStepId: 'ut_d' })!
    expect(list.map(c => c.stepId)).toEqual(['ut_a', 'ut_b', 'ut_c', 'ut_d'])
    expect(list[0]).toMatchObject({ userText: 'A', resultText: '答A' })
  })

  it('锚点是主动提醒 → 不挑选', () => {
    expect(Conversation.listCompanionPickCandidates(sixRecords(), { anchorTaskStepId: 'ut_p' })).toBeNull()
  })

  it('挑中的段整段带上（用户话、回复、API 消息），没挑中的不带，终点恒带，终点之后不带', () => {
    // 锚点 D，只挑 A：B、C 虽然时间上更近，但没被挑中
    const result = Conversation.extractTaskFromRecords(sixRecords(), 'sess_new', {
      anchorTaskStepId: 'ut_d',
      pickedTaskStepIds: ['ut_a']
    })!
    const stepIds = result.record.steps!.map(s => s.id)
    expect(stepIds).toEqual(['ut_a', 'fr_a', 'ut_d', 'fr_d'])
    expect(result.record.messages!.map(m => m.content)).toEqual(['A', '答A', 'D', '答D'])
    expect(result.record.userTask).toBe('D')
    expect(result.record.kind).toBe('task')
  })

  it('紧挨在入选段前面的主动提醒一并带上；没挨着的不带', () => {
    // A B [p] C D E：挑 C → 带上它前面的 p；B 没挑，不带
    const withC = Conversation.extractTaskFromRecords(sixRecords(), 'sess_c', {
      anchorTaskStepId: 'ut_e',
      pickedTaskStepIds: ['ut_c']
    })!
    expect(withC.record.steps!.map(s => s.id)).toEqual(['ut_p', 'fr_p', 'ut_c', 'fr_c', 'ut_e', 'fr_e'])

    // 挑 B：B 前面是 A（不是提醒），p 不挨着 B 也不在入选段前
    const withB = Conversation.extractTaskFromRecords(sixRecords(), 'sess_b', {
      anchorTaskStepId: 'ut_e',
      pickedTaskStepIds: ['ut_b']
    })!
    expect(withB.record.steps!.some(s => s.id === 'ut_p')).toBe(false)
  })

  it('回复里写了终点之后的段、或对不上的 id → 忽略，只留终点', () => {
    const result = Conversation.extractTaskFromRecords(sixRecords(), 'sess_x', {
      anchorTaskStepId: 'ut_b',
      pickedTaskStepIds: ['ut_e', 'ut_zzz']
    })!
    expect(result.record.messages!.map(m => m.content)).toEqual(['B', '答B'])
  })

  it('没有 pickedTaskStepIds → 仍走时间窗口老办法（6 小时内的全带，窗口内的提醒也带）', () => {
    const result = Conversation.extractTaskFromRecords(sixRecords(), 'sess_window', {
      anchorTaskStepId: 'ut_d'
    })!
    expect(result.record.messages!.map(m => m.content)).toEqual(['A', '答A', 'B', '答B', '通知p', 'C', '答C', 'D', '答D'])
  })
})

describe('思考过程预览', () => {
  it('只留末尾一段，不把 emoji 切成半个', () => {
    expect(thinkingPreview('  短  ')).toBe('  短')
    const emoji = '🙂'.repeat(200)
    const preview = thinkingPreview(emoji)
    expect(preview.startsWith('…')).toBe(true)
    expect(preview.endsWith('🙂')).toBe(true)
    expect(Array.from(preview)).toHaveLength(161)
  })

  it('第一次立刻交出，紧接着的增量先攒着，结束时再交一次', () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const feed = createThinkingFeed(text => seen.push(text))
      feed.push('甲')
      feed.push('乙')
      expect(seen).toEqual(['甲'])
      vi.advanceTimersByTime(200)
      expect(seen).toEqual(['甲', '甲乙'])
      feed.push('丙')
      feed.flush()
      expect(seen.at(-1)).toBe('甲乙丙')
    } finally {
      vi.useRealTimers()
    }
  })

  it('想得很长时，提示里仍是末尾几句', () => {
    const seen: string[] = []
    const feed = createThinkingFeed(text => seen.push(text))
    feed.push('头'.repeat(2000))
    feed.push('尾巴')
    feed.flush()
    expect(seen.at(-1)?.startsWith('…')).toBe(true)
    expect(seen.at(-1)?.endsWith('尾巴')).toBe(true)
  })
})

describe('AgentService.extractTaskFromCompanion 的挑选', () => {
  /** 建一个带 historyService 的 service；联络记录由 sourceSteps 提供，磁盘记录为空 */
  function setup(chatWithTools?: ReturnType<typeof vi.fn>) {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn(), ...(chatWithTools ? { chatWithTools } : {}) } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)
    const saved: AgentRecord[] = []
    const historyService = {
      getAgentRecordStore: vi.fn(() => historyService),
      getRecentRecordsByAgentKey: vi.fn().mockReturnValue([]),
      saveAgentRecord: vi.fn((r: AgentRecord) => { saved.push(r) }),
      getAgentRecordById: vi.fn()
    }
    service.setHistoryService(historyService as any)
    return { service, saved, ai }
  }

  const sourceSteps = () => [
    ...userChunk('a', '查发票', 0),
    ...userChunk('b', '聊天气', 10),
    ...userChunk('c', '发票发给财务', 20)
  ]

  it('联络眼前没有对话前缀 → 只发各段简述；挑到的按序号带上', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '1,3' })
    const { service, saved } = setup(chat)

    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-pick',
      anchorTaskStepId: 'ut_c',
      sourceSteps: sourceSteps()
    })

    expect(chat).toHaveBeenCalledTimes(1)
    const [messages, tools] = chat.mock.calls[0]
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toContain('1. ')
    expect(messages[0].content).toContain('用户：查发票')
    expect(tools).toEqual([])
    // 挑了 1 和 3：带 查发票 + 发票发给财务，不带 聊天气
    const userSteps = saved[0].steps!.filter(s => s.type === 'user_task').map(s => s.content)
    expect(userSteps).toEqual(['查发票', '发票发给财务'])
    expect(result!.sourceUserTask).toBe('发票发给财务')
  })

  it('联络眼前有对话前缀 → 接在前缀后面问，前缀末尾落缓存断点，带 tools', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '2,3' })
    const { service, saved } = setup(chat)
    const companion = (service as any).createAssistantAgent('__companion__')
    const prefix: AiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '查发票' },
      { role: 'assistant', content: '答查发票' }
    ]
    companion.attachConversation(
      Conversation.create(
        { agentKey: '__companion__', terminalType: 'assistant' },
        { id: 'live_c', createdAt: T0 },
        { taskMemory: companion.taskMemory }
      ),
      { cachePrefix: prefix }
    )

    await service.extractTaskFromCompanion({
      newAgentId: 'new-pick-hot',
      anchorTaskStepId: 'ut_c',
      sourceSteps: sourceSteps()
    })

    expect(chat).toHaveBeenCalledTimes(1)
    const [messages, tools] = chat.mock.calls[0]
    expect(messages).toHaveLength(prefix.length + 1)
    expect(messages.slice(0, prefix.length).map((m: AiMessage) => m.content)).toEqual(prefix.map(m => m.content))
    expect(messages[prefix.length - 1]._cacheBreakpoint).toBe(true)
    expect(messages[prefix.length].role).toBe('user')
    expect(messages[prefix.length].content).toContain('用户：发票发给财务')
    expect(Array.isArray(tools)).toBe(true)
    // 挑了 2 和 3
    expect(saved[0].steps!.filter(s => s.type === 'user_task').map(s => s.content)).toEqual(['聊天气', '发票发给财务'])
  })

  it('要看思考过程时走流式，接在前缀后问，正文仍按序号解析', async () => {
    const seen: string[] = []
    const { service, saved, ai } = setup()
    ai.chatWithToolsCollecting = vi.fn(async (_messages: unknown, _tools: unknown, _profile: unknown, opts: { onReasoning?: (delta: string) => void }) => {
      opts.onReasoning?.('先对一下发票。')
      opts.onReasoning?.('天气那段无关。')
      return { content: '1,3' }
    })
    const companion = (service as any).createAssistantAgent('__companion__')
    const prefix: AiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '查发票' },
      { role: 'assistant', content: '答查发票' }
    ]
    companion.attachConversation(
      Conversation.create(
        { agentKey: '__companion__', terminalType: 'assistant' },
        { id: 'live_think', createdAt: T0 },
        { taskMemory: companion.taskMemory }
      ),
      { cachePrefix: prefix }
    )

    await service.extractTaskFromCompanion({
      newAgentId: 'new-think',
      anchorTaskStepId: 'ut_c',
      sourceSteps: sourceSteps()
    }, { onThinking: text => seen.push(text) })

    expect(ai.chatWithToolsCollecting).toHaveBeenCalledTimes(1)
    expect(ai.chatWithTools).toBeUndefined()
    const [messages] = ai.chatWithToolsCollecting.mock.calls[0]
    expect(messages).toHaveLength(prefix.length + 1)
    expect(messages[prefix.length - 1]._cacheBreakpoint).toBe(true)
    expect(seen.at(-1)).toContain('天气那段无关')
    expect(seen.at(-1)).not.toContain('1,3')
    expect(saved[0].steps!.filter(s => s.type === 'user_task').map(s => s.content)).toEqual(['查发票', '发票发给财务'])
  })

  it('只有思考、没有序号正文 → 回退时间窗口', async () => {
    const { service, saved, ai } = setup()
    ai.chatWithToolsCollecting = vi.fn().mockResolvedValue({
      content: '<details>先想发票</details>',
      thinkingOnly: true
    })

    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-think-only',
      anchorTaskStepId: 'ut_c',
      sourceSteps: sourceSteps()
    }, { onThinking: () => {} })

    expect(result).not.toBeNull()
    expect(saved[0].steps!.filter(s => s.type === 'user_task').map(s => s.content))
      .toEqual(['查发票', '聊天气', '发票发给财务'])
  })

  it('回复对不上序号 → 回退时间窗口（三段都在 6h 内，全带）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '选 1 和 3，因为发票' })
    const { service, saved } = setup(chat)

    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-fallback',
      anchorTaskStepId: 'ut_c',
      sourceSteps: sourceSteps()
    })

    expect(result).not.toBeNull()
    expect(saved[0].steps!.filter(s => s.type === 'user_task').map(s => s.content))
      .toEqual(['查发票', '聊天气', '发票发给财务'])
  })

  it('挑选请求抛错 → 回退时间窗口，任务照常创建', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('network down'))
    const { service, saved } = setup(chat)

    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-error',
      anchorTaskStepId: 'ut_c',
      sourceSteps: sourceSteps()
    })

    expect(result).not.toBeNull()
    expect(saved[0].steps!.filter(s => s.type === 'user_task')).toHaveLength(3)
  })

  it('点在主动提醒上 → 不发挑选，只带这一条', async () => {
    const chat = vi.fn()
    const { service, saved } = setup(chat)

    await service.extractTaskFromCompanion({
      newAgentId: 'new-proactive',
      anchorTaskStepId: 'ut_p',
      sourceSteps: [...sourceSteps(), ...proactiveChunk('p', 30)]
    })

    expect(chat).not.toHaveBeenCalled()
    expect(saved[0].steps!.some(s => s.content === '查发票')).toBe(false)
  })

  it('只有终点一段 → 不发挑选', async () => {
    const chat = vi.fn()
    const { service } = setup(chat)

    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-single',
      anchorTaskStepId: 'ut_a',
      sourceSteps: userChunk('a', '查发票', 0)
    })

    expect(chat).not.toHaveBeenCalled()
    expect(result).not.toBeNull()
  })
})
