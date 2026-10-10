/**
 * task-supervisor.ts 单元测试
 * 覆盖交办—回执闭环：查询（list/inspect）、操作（confirm/stop/create/instruct）、
 * 联络开头的那一轮回执只交给联络、用户开头的什么都不送、事件源 kind 过滤（防循环）
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

import { TaskSupervisor, type TaskSupervisorHost } from '../task-supervisor'
import type { SailFish } from '../sailfish'

const COMPANION = '__companion__'

interface MockAgentOptions {
  isRunning?: boolean
  phase?: string
  stepCount?: number
  title?: string
  firstUserTask?: string
  sessionId?: string
  terminalType?: 'local' | 'ssh' | 'assistant'
  pendingConfirmation?: {
    toolCallId: string
    toolName: string
    riskLevel: 'dangerous'
    displayName?: string
    argsPreview: string
  }
}

function makeMockAgent(opts: MockAgentOptions = {}): SailFish {
  return {
    getRunStatus: vi.fn().mockReturnValue({
      isRunning: opts.isRunning ?? false,
      phase: opts.phase,
      currentToolName: undefined,
      stepCount: opts.stepCount ?? 0
    }),
    getTerminalType: vi.fn().mockReturnValue(opts.terminalType ?? 'assistant'),
    getSessionId: vi.fn().mockReturnValue(opts.sessionId),
    getPendingConfirmationInfo: vi.fn().mockReturnValue(opts.pendingConfirmation),
    getConversationTitle: vi.fn().mockReturnValue(opts.title),
    getSessionStepsSnapshot: vi.fn().mockReturnValue(
      opts.firstUserTask
        ? [{ id: 's1', type: 'user_task', content: opts.firstUserTask, timestamp: Date.now() }]
        : []
    ),
  } as unknown as SailFish
}

function makeHost(entries: Array<[string, SailFish]>, overrides: Partial<TaskSupervisorHost> = {}): TaskSupervisorHost & {
  confirmToolCall: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  say: ReturnType<typeof vi.fn>
  prepareAssignedTask: ReturnType<typeof vi.fn>
  deliverCompanionReceipt: ReturnType<typeof vi.fn>
} {
  const map = new Map(entries)
  return {
    getAllAgentEntries: vi.fn(() => Array.from(map.entries()).map(([agentKey, agent]) => ({ agentKey, agent }))),
    getAgent: vi.fn((key: string) => map.get(key)),
    confirmToolCall: vi.fn().mockReturnValue(true),
    abort: vi.fn().mockReturnValue(true),
    say: vi.fn().mockResolvedValue({ outcome: 'ran', result: 'done' }),
    prepareAssignedTask: vi.fn(),
    deliverCompanionReceipt: vi.fn(),
    getHistoryService: vi.fn().mockReturnValue(undefined),
    getConfigService: vi.fn().mockReturnValue(undefined),
    ...overrides
  } as TaskSupervisorHost & {
    confirmToolCall: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
    say: ReturnType<typeof vi.fn>
    prepareAssignedTask: ReturnType<typeof vi.fn>
    deliverCompanionReceipt: ReturnType<typeof vi.fn>
  }
}

describe('TaskSupervisor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // ==================== 查询 ====================

  describe('listSupervisedTasks', () => {
    it('仅枚举 kind=task 的会话，排除 companion/watch/wakeup 和任务的帮手', () => {
      const host = makeHost([
        ['tab-aaa', makeMockAgent({ title: '任务A' })],
        [COMPANION, makeMockAgent({ title: '联络' })],
        ['__watch__:w1', makeMockAgent({ title: '关切' })],
        ['__wakeup__', makeMockAgent({ title: '唤醒' })],
        ['tab-aaa:sub:explore', makeMockAgent({ title: '帮手' })]
      ])
      const supervisor = new TaskSupervisor(host)
      const list = supervisor.listSupervisedTasks()
      expect(list.map(t => t.agentKey)).toEqual(['tab-aaa'])
    })

    it('待确认 > 运行中 > 空闲 排序', () => {
      const host = makeHost([
        ['tab-idle', makeMockAgent({ title: '空闲' })],
        ['tab-running', makeMockAgent({ title: '运行', isRunning: true })],
        ['tab-confirm', makeMockAgent({
          title: '确认',
          pendingConfirmation: { toolCallId: 'c1', toolName: 'exec', riskLevel: 'dangerous', argsPreview: '{}' }
        })]
      ])
      const supervisor = new TaskSupervisor(host)
      const list = supervisor.listSupervisedTasks()
      expect(list.map(t => t.agentKey)).toEqual(['tab-confirm', 'tab-running', 'tab-idle'])
    })

    it('单个任务状态异常不拖垮整个列表（跳过并继续）', () => {
      const broken = {
        getRunStatus: vi.fn(() => { throw new Error('agent disposing') }),
        getPendingConfirmationInfo: vi.fn(),
        getConversationTitle: vi.fn(),
        getSessionStepsSnapshot: vi.fn().mockReturnValue([]),
        getTerminalType: vi.fn()
      } as unknown as SailFish
      const host = makeHost([
        ['tab-broken', broken],
        ['tab-ok', makeMockAgent({ title: '正常任务' })]
      ])
      const supervisor = new TaskSupervisor(host)
      const list = supervisor.listSupervisedTasks()
      expect(list.map(t => t.agentKey)).toEqual(['tab-ok'])
    })
  })

  describe('inspectTask', () => {
    it('非 task 会话返回 undefined', () => {
      const host = makeHost([[COMPANION, makeMockAgent({ title: '联络' })]])
      const supervisor = new TaskSupervisor(host)
      expect(supervisor.inspectTask(COMPANION)).toBeUndefined()
    })

    it('返回近况摘要，标题取自定义标题优先', () => {
      const host = makeHost([['tab-x', makeMockAgent({ title: '写周报', firstUserTask: '帮我写一份很长很长的周报' })]])
      const supervisor = new TaskSupervisor(host)
      const detail = supervisor.inspectTask('tab-x')
      expect(detail?.title).toBe('写周报')
      expect(detail?.recentSteps).toHaveLength(1)
    })
  })

  describe('历史找回', () => {
    const summary = {
      id: 'session_old',
      timestamp: 1,
      duration: 10,
      userTask: '查昨天的错误日志，写一份摘要',
      title: '查日志',
      terminalType: 'assistant' as const,
      agentKey: 'assistant-old',
      status: 'completed' as const,
    }

    function historyHost(extraEntries: Array<[string, SailFish]> = []) {
      return makeHost(extraEntries, {
        getHistoryService: vi.fn().mockReturnValue({
          listAgentHistorySummaries: vi.fn().mockReturnValue([
            summary,
            { ...summary, id: 'session_older', timestamp: 0 },
            { ...summary, id: 'session_sub', agentKey: 'assistant-old:sub:explore', title: '帮手' },
            { ...summary, id: 'session_live', agentKey: 'tab-live', title: '还在' },
          ]),
          getLatestRecordByAgentKey: vi.fn((key: string) => {
            if (key !== 'assistant-old') return undefined
            return {
              ...summary,
              steps: [
                { id: 's1', type: 'user_task', content: '查昨天的错误日志', timestamp: 1 },
                { id: 's2', type: 'final_result', content: '没有新的错误', timestamp: 2 },
              ],
            }
          }),
        }),
      })
    }

    it('内存里没有的任务从历史补进列表，同一任务不重复，帮手不进', () => {
      const host = historyHost([['tab-live', makeMockAgent({ title: '还在内存里' })]])
      const list = new TaskSupervisor(host).listSupervisedTasks()
      expect(list.map(t => t.agentKey)).toEqual(['tab-live', 'assistant-old'])
      expect(list[1]?.settled).toBe('completed')
      expect(list[1]?.title).toBe('查日志')
    })

    it('内存里没有时，inspect 从历史读近况', () => {
      const detail = new TaskSupervisor(historyHost()).inspectTask('assistant-old')
      expect(detail?.title).toBe('查日志')
      expect(detail?.settled).toBe('completed')
      expect(detail?.stepCount).toBe(2)
      expect(detail?.recentSteps.some(line => line.includes('没有新的错误'))).toBe(true)
    })

    it('已经结束的任务不能再批准或停止', () => {
      const host = historyHost()
      const supervisor = new TaskSupervisor(host)
      expect(supervisor.confirmTask('assistant-old', 'call-1', true)).toMatchObject({
        ok: false, reason: 'settled', title: '查日志',
      })
      expect(host.confirmToolCall).not.toHaveBeenCalled()
      expect(supervisor.stopTask('assistant-old')).toMatchObject({
        ok: false, reason: 'settled', title: '查日志',
      })
      expect(host.abort).not.toHaveBeenCalled()
    })
  })

  // ==================== 回执：联络开头的那一轮只交给联络 ====================

  describe('确认', () => {
    const confirmEvent = {
      toolCallId: 'call-123',
      toolName: 'exec',
      riskLevel: 'dangerous' as const,
      displayName: '执行命令',
      argsPreview: '{"command":"rm -rf /tmp/x"}',
      ledBy: 'companion' as const,
    }

    it('联络开头的那一轮挂起确认 → 立刻交给联络，带上 task_id 和 tool_call_id', () => {
      const host = makeHost([['tab-t1', makeMockAgent({ title: '部署服务' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleNeedsConfirmation('tab-t1', confirmEvent)

      expect(host.deliverCompanionReceipt).toHaveBeenCalledTimes(1)
      const receipt = host.deliverCompanionReceipt.mock.calls[0][0] as string
      expect(receipt).toContain('call-123')
      expect(receipt).toContain('tab-t1')
      expect(receipt).toContain('部署服务')
      expect(receipt).toContain('talk_to_user')
    })

    it('用户开头的那一轮挂起确认 → 不送联络', () => {
      const host = makeHost([['tab-t1', makeMockAgent({ title: '部署服务' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleNeedsConfirmation('tab-t1', { ...confirmEvent, ledBy: undefined })

      expect(host.deliverCompanionReceipt).not.toHaveBeenCalled()
    })

    it('联络 confirm → 传达给任务的 confirmToolCall', () => {
      const host = makeHost([['tab-t1', makeMockAgent({ title: '部署服务' })]])
      const supervisor = new TaskSupervisor(host)

      const result = supervisor.confirmTask('tab-t1', 'call-123', true)

      expect(result).toEqual({ ok: true, title: '部署服务' })
      expect(host.confirmToolCall).toHaveBeenCalledWith('tab-t1', 'call-123', true)
    })

    it('迟到的 confirm（任务侧已处理）→ 返回「已处理」', () => {
      const host = makeHost([['tab-t1', makeMockAgent({ title: '部署服务' })],])
      host.confirmToolCall.mockReturnValue(false)
      const supervisor = new TaskSupervisor(host)

      const result = supervisor.confirmTask('tab-t1', 'call-123', false)

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('confirmation_stale')
    })

    it('confirm 目标不是 task 会话 → 拒绝且不触达 host', () => {
      const host = makeHost([[COMPANION, makeMockAgent({ title: '联络' })]])
      const supervisor = new TaskSupervisor(host)

      const result = supervisor.confirmTask(COMPANION, 'call-x', true)

      expect(result).toEqual({ ok: false, reason: 'task_not_found' })
      expect(host.confirmToolCall).not.toHaveBeenCalled()
    })

    it('联络/watch/wakeup/帮手自身的确认请求不回流（防循环）', () => {
      const host = makeHost([
        [COMPANION, makeMockAgent({ title: '联络' })],
        ['__watch__:w1', makeMockAgent({ title: '关切' })]
      ])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleNeedsConfirmation(COMPANION, confirmEvent)
      supervisor.handleNeedsConfirmation('__watch__:w1', confirmEvent)
      supervisor.handleNeedsConfirmation(undefined, confirmEvent)
      supervisor.handleNeedsConfirmation('tab-t1:sub:explore', confirmEvent)

      expect(host.deliverCompanionReceipt).not.toHaveBeenCalled()
    })

    it('确认不等防抖，防抖窗口里攒着的完成事件一并带上', () => {
      vi.useFakeTimers()
      const host = makeHost([
        ['tab-t1', makeMockAgent({ title: '任务一' })],
        ['tab-t2', makeMockAgent({ title: '任务二' })]
      ])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished('tab-t1', { status: 'success', summary: '完成一', ledBy: 'companion' })
      supervisor.handleNeedsConfirmation('tab-t2', confirmEvent)

      expect(host.deliverCompanionReceipt).toHaveBeenCalledTimes(1)
      const receipt = host.deliverCompanionReceipt.mock.calls[0][0] as string
      expect(receipt).toContain('完成一')
      expect(receipt).toContain('call-123')

      vi.advanceTimersByTime(10000)
      expect(host.deliverCompanionReceipt).toHaveBeenCalledTimes(1)
    })
  })

  describe('提问', () => {
    it('联络开头的那一轮向用户提问 → 立刻交给联络，带上问题和选项', () => {
      const host = makeHost([['assistant-a', makeMockAgent({ title: '订会议室' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleAsking('assistant-a', { question: '订哪一间？', options: ['A101', 'B202'], ledBy: 'companion' })

      expect(host.deliverCompanionReceipt).toHaveBeenCalledTimes(1)
      const receipt = host.deliverCompanionReceipt.mock.calls[0][0] as string
      expect(receipt).toContain('订会议室')
      expect(receipt).toContain('assistant-a')
      expect(receipt).toContain('订哪一间？')
      expect(receipt).toContain('A101 / B202')
    })

    it('用户开头的那一轮提问 → 不送联络', () => {
      const host = makeHost([['assistant-a', makeMockAgent({ title: '订会议室' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleAsking('assistant-a', { question: '订哪一间？', options: [] })

      expect(host.deliverCompanionReceipt).not.toHaveBeenCalled()
    })
  })

  describe('完成', () => {
    it('联络开头的那一轮做完 → 防抖后交给联络', () => {
      vi.useFakeTimers()
      const host = makeHost([['tab-t1', makeMockAgent({ title: '整理日志' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished('tab-t1', { status: 'success', summary: '整理完成，共 3 个文件', ledBy: 'companion' })
      expect(host.deliverCompanionReceipt).not.toHaveBeenCalled()

      vi.advanceTimersByTime(5000)

      expect(host.deliverCompanionReceipt).toHaveBeenCalledTimes(1)
      const receipt = host.deliverCompanionReceipt.mock.calls[0][0] as string
      expect(receipt).toContain('整理日志')
      expect(receipt).toContain('整理完成')
      expect(receipt).toContain('tab-t1')
    })

    it('短时间多条完成/失败合并成一份回执', () => {
      vi.useFakeTimers()
      const host = makeHost([
        ['tab-t1', makeMockAgent({ title: '任务一' })],
        ['tab-t2', makeMockAgent({ title: '任务二' })]
      ])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished('tab-t1', { status: 'success', summary: '完成一', ledBy: 'companion' })
      vi.advanceTimersByTime(1000)
      supervisor.handleRunFinished('tab-t2', { status: 'failed', summary: '失败二', ledBy: 'companion' })
      vi.advanceTimersByTime(5000)

      expect(host.deliverCompanionReceipt).toHaveBeenCalledTimes(1)
      const receipt = host.deliverCompanionReceipt.mock.calls[0][0] as string
      expect(receipt).toContain('任务一')
      expect(receipt).toContain('任务二')
    })

    it('用户开头的那一轮做完 → 什么都不送', () => {
      vi.useFakeTimers()
      const host = makeHost([['tab-t1', makeMockAgent({ title: '整理日志' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished('tab-t1', { status: 'success', summary: '整理完成' })
      vi.advanceTimersByTime(10000)

      expect(host.deliverCompanionReceipt).not.toHaveBeenCalled()
    })

    it('联络自身完成不冒泡；watch/wakeup/帮手不冒泡', () => {
      vi.useFakeTimers()
      const host = makeHost([[COMPANION, makeMockAgent({ title: '联络' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished(COMPANION, { status: 'success', summary: '联络回复完毕', ledBy: 'companion' })
      supervisor.handleRunFinished('__wakeup__', { status: 'success', summary: '心跳', ledBy: 'companion' })
      supervisor.handleRunFinished(undefined, { status: 'success', summary: '无属主', ledBy: 'companion' })
      supervisor.handleRunFinished('tab-t1:sub:explore', { status: 'success', summary: '帮手做完了', ledBy: 'companion' })
      vi.advanceTimersByTime(10000)

      expect(host.deliverCompanionReceipt).not.toHaveBeenCalled()
    })
  })

  // ==================== 操作 ====================

  describe('stopTask', () => {
    it('停止执行中的任务 → 调用 host.abort', () => {
      const host = makeHost([['tab-t1', makeMockAgent({ title: '长跑任务', isRunning: true })]])
      const supervisor = new TaskSupervisor(host)

      const result = supervisor.stopTask('tab-t1')

      expect(result).toEqual({ ok: true, title: '长跑任务' })
      expect(host.abort).toHaveBeenCalledWith('tab-t1')
    })

    it('任务不存在 → task_not_found', () => {
      const host = makeHost([])
      const supervisor = new TaskSupervisor(host)
      expect(supervisor.stopTask('nope').reason).toBe('task_not_found')
    })
  })

  describe('createTask', () => {
    it('新开一场助手对话，把简报作为第一句说进去（与界面同一入口）', async () => {
      const host = makeHost([])
      const supervisor = new TaskSupervisor(host)

      const { agentKey } = await supervisor.createTask({ title: '查日志', brief: '查一下昨天的错误日志', fullAuto: true })

      expect(agentKey).toMatch(/^assistant-/)
      expect(host.prepareAssignedTask).toHaveBeenCalledWith(agentKey, '查日志', 'free')
      expect(host.say).toHaveBeenCalledTimes(1)
      const [agentId, message, context, opts] = host.say.mock.calls[0]
      expect(agentId).toBe(agentKey)
      expect(message).toBe('查一下昨天的错误日志')
      expect(context.terminalType).toBe('assistant')
      expect(opts.surface).toBe('assistant')
      expect(opts.ledBy).toBe('companion')
      // 审批方式记在那场对话上，不随每一轮传执行档
      expect(opts.config.executionMode).toBeUndefined()
    })

    it('没说全自动：那场的审批方式是替我审批', async () => {
      const host = makeHost([])
      const supervisor = new TaskSupervisor(host)

      await supervisor.createTask({ title: '问个问题', brief: '简述项目结构' })

      expect(host.prepareAssignedTask).toHaveBeenCalledWith(expect.stringMatching(/^assistant-/), '问个问题', 'autoReview')
    })
  })

  describe('flushPendingEvents', () => {
    it('立即冲刷防抖窗口里的回执', async () => {
      vi.useFakeTimers()
      const host = makeHost([['tab-t1', makeMockAgent({ title: '整理日志' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished('tab-t1', { status: 'success', summary: '整理完成', ledBy: 'companion' })
      expect(host.deliverCompanionReceipt).not.toHaveBeenCalled()

      const flush = supervisor.flushPendingEvents()
      await vi.advanceTimersByTimeAsync(100)
      await flush

      expect(host.deliverCompanionReceipt).toHaveBeenCalledTimes(1)
      expect(host.deliverCompanionReceipt.mock.calls[0][0]).toContain('整理日志')
    })

    it('空缓冲冲刷不投递', async () => {
      vi.useFakeTimers()
      const host = makeHost([])
      const supervisor = new TaskSupervisor(host)

      const flush = supervisor.flushPendingEvents()
      await vi.advanceTimersByTimeAsync(100)
      await flush

      expect(host.deliverCompanionReceipt).not.toHaveBeenCalled()
    })
  })

  describe('再交代', () => {
    function record(overrides: Record<string, unknown> = {}) {
      return {
        id: 'session_old',
        timestamp: 10,
        duration: 5,
        userTask: '原来的要求',
        title: '查日志',
        terminalType: 'assistant' as const,
        agentKey: 'assistant-old',
        status: 'completed' as const,
        ...overrides,
      }
    }

    it('正在跑的任务：说进那场，回报当场听见；不改它的运行设置', async () => {
      const host = makeHost([['tab-live', makeMockAgent({ title: '查日志', isRunning: true, sessionId: 'session_live', terminalType: 'local' })]])
      const result = await new TaskSupervisor(host).instructTask('tab-live', '  再看一下今天的 ')
      expect(result).toEqual({ ok: true, title: '查日志', delivered: 'now' })
      expect(host.say).toHaveBeenCalledWith(
        'tab-live',
        '再看一下今天的',
        expect.objectContaining({ terminalType: 'local', sessionId: 'session_live' }),
        { surface: 'terminal', config: undefined, ledBy: 'companion' }
      )
    })

    it('还在内存里但已经停了，接着原来那场', async () => {
      const host = makeHost([['tab-idle', makeMockAgent({ title: '查日志', sessionId: 'session_idle', terminalType: 'local' })]])
      const result = await new TaskSupervisor(host).instructTask('tab-idle', '把结论写短一点')
      expect(result.ok).toBe(true)
      expect(result.delivered).toBe('next')
      expect(host.say).toHaveBeenCalledWith(
        'tab-idle',
        '把结论写短一点',
        expect.objectContaining({ terminalType: 'local', sessionId: 'session_idle' }),
        { surface: 'terminal', config: undefined, ledBy: 'companion' }
      )
    })

    it('只在历史里的助手任务，用原来的会话接着做', async () => {
      const saved = record()
      const host = makeHost([], {
        getHistoryService: vi.fn().mockReturnValue({
          getLatestRecordByAgentKey: vi.fn((key: string) => key === 'assistant-old' ? saved : undefined),
        }),
      })
      const result = await new TaskSupervisor(host).instructTask('assistant-old', '再补一段')
      expect(result).toMatchObject({ ok: true, title: '查日志', delivered: 'next' })
      expect(host.say).toHaveBeenCalledWith(
        'assistant-old',
        '再补一段',
        expect.objectContaining({ terminalType: 'assistant', sessionId: 'session_old', sessionStartTime: 10 }),
        expect.objectContaining({ surface: 'assistant', config: expect.objectContaining({ enabled: true }) })
      )
    })

    it('只在历史里的本机终端，同样接着原来那场', async () => {
      const saved = record({ agentKey: 'tab-local', terminalType: 'local', title: '本机排查' })
      const host = makeHost([], {
        getHistoryService: vi.fn().mockReturnValue({
          getLatestRecordByAgentKey: vi.fn((key: string) => key === 'tab-local' ? saved : undefined),
        }),
      })
      const result = await new TaskSupervisor(host).instructTask('tab-local', '再跑一次')
      expect(result.ok).toBe(true)
      expect(host.say).toHaveBeenCalledWith(
        'tab-local',
        '再跑一次',
        expect.objectContaining({ terminalType: 'local', sessionId: 'session_old' }),
        expect.objectContaining({ surface: 'terminal' })
      )
    })

    it('远程终端窗口已经不在，不重新连上', async () => {
      const saved = record({ agentKey: 'tab-ssh', terminalType: 'ssh', title: '远端', sshHost: 'a@b' })
      const host = makeHost([], {
        getHistoryService: vi.fn().mockReturnValue({
          getLatestRecordByAgentKey: vi.fn((key: string) => key === 'tab-ssh' ? saved : undefined),
        }),
      })
      const result = await new TaskSupervisor(host).instructTask('tab-ssh', '再看一眼')
      expect(result).toEqual({ ok: false, reason: 'terminal_closed', title: '远端' })
      expect(host.say).not.toHaveBeenCalled()
    })

    it('帮手和空话不送', async () => {
      const host = makeHost([['tab-live:sub:explore', makeMockAgent({ title: '帮手', isRunning: true })]])
      expect(await new TaskSupervisor(host).instructTask('tab-live:sub:explore', '去做')).toEqual({ ok: false, reason: 'task_not_found' })
      expect(await new TaskSupervisor(host).instructTask('tab-live', '   ')).toEqual({ ok: false, reason: 'task_not_found' })
      expect(host.say).not.toHaveBeenCalled()
    })
  })
})
