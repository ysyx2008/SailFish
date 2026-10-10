/**
 * task-supervisor.ts 单元测试
 * 覆盖交办—复命闭环：查询（list/inspect）、操作（confirm/stop/create）、
 * 确认冒泡（转述制）、复命防抖聚合、事件源 kind 过滤（防循环）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// deliverProactiveMessage 涉及 IM/系统通知/历史落盘，单测只断言调用参数
vi.mock('../proactive-deliver', () => ({
  deliverProactiveMessage: vi.fn().mockResolvedValue({ deliveredVia: ['app'], failedChannels: [] })
}))

import { TaskSupervisor, type TaskSupervisorHost } from '../task-supervisor'
import { deliverProactiveMessage } from '../proactive-deliver'
import { consumeProactiveContext, addProactiveContext } from '../proactive-store'
import type { SailFish } from '../sailfish'

const COMPANION = '__companion__'

const mockDeliver = vi.mocked(deliverProactiveMessage)

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
} {
  const map = new Map(entries)
  return {
    getAllAgentEntries: vi.fn(() => Array.from(map.entries()).map(([agentKey, agent]) => ({ agentKey, agent }))),
    getAgent: vi.fn((key: string) => map.get(key)),
    confirmToolCall: vi.fn().mockReturnValue(true),
    abort: vi.fn().mockReturnValue(true),
    say: vi.fn().mockResolvedValue({ outcome: 'ran', result: 'done' }),
    prepareAssignedTask: vi.fn(),
    getHistoryService: vi.fn().mockReturnValue(undefined),
    getConfigService: vi.fn().mockReturnValue(undefined),
    ...overrides
  } as TaskSupervisorHost & {
    confirmToolCall: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
    say: ReturnType<typeof vi.fn>
    prepareAssignedTask: ReturnType<typeof vi.fn>
  }
}

describe('TaskSupervisor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 清空联络线暂存上下文，避免用例间串味
    consumeProactiveContext(COMPANION)
  })

  afterEach(() => {
    vi.useRealTimers()
    consumeProactiveContext(COMPANION)
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

  // ==================== T5：确认冒泡（转述制） ====================

  describe('确认冒泡', () => {
    const confirmEvent = {
      toolCallId: 'call-123',
      toolName: 'exec',
      riskLevel: 'dangerous' as const,
      displayName: '执行命令',
      argsPreview: '{"command":"rm -rf /tmp/x"}'
    }

    it('任务挂起确认 → 联络线暂存上下文含 toolCallId 且立即投递 notice', () => {
      const host = makeHost([['tab-t1', makeMockAgent({ title: '部署服务' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleNeedsConfirmation('tab-t1', confirmEvent)

      const ctx = consumeProactiveContext(COMPANION)
      expect(ctx).toContain('call-123')
      expect(ctx).toContain('tab-t1')
      expect(ctx).toContain('部署服务')
      expect(mockDeliver).toHaveBeenCalledTimes(1)
      expect(mockDeliver.mock.calls[0][0]).toContain('部署服务')
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

    it('联络/watch/wakeup 自身的确认请求不回流（防循环）', () => {
      const host = makeHost([
        [COMPANION, makeMockAgent({ title: '联络' })],
        ['__watch__:w1', makeMockAgent({ title: '关切' })]
      ])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleNeedsConfirmation(COMPANION, confirmEvent)
      supervisor.handleNeedsConfirmation('__watch__:w1', confirmEvent)
      supervisor.handleNeedsConfirmation(undefined, confirmEvent)
      supervisor.handleNeedsConfirmation('tab-t1:sub:explore', confirmEvent)

      expect(consumeProactiveContext(COMPANION)).toBeUndefined()
      expect(mockDeliver).not.toHaveBeenCalled()
    })

    it('多个待确认按到达顺序追加，后到的不覆盖先到的', () => {
      const host = makeHost([
        ['tab-t1', makeMockAgent({ title: '任务一' })],
        ['tab-t2', makeMockAgent({ title: '任务二' })]
      ])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleNeedsConfirmation('tab-t1', { ...confirmEvent, toolCallId: 'call-1' })
      supervisor.handleNeedsConfirmation('tab-t2', { ...confirmEvent, toolCallId: 'call-2' })

      const ctx = consumeProactiveContext(COMPANION)
      expect(ctx).toContain('call-1')
      expect(ctx).toContain('call-2')
    })
  })

  // ==================== T6：复命闭环 ====================

  describe('复命闭环', () => {
    it('任务完成 → 防抖后联络线收到复命 notice + 暂存上下文', () => {
      vi.useFakeTimers()
      const host = makeHost([['tab-t1', makeMockAgent({ title: '整理日志' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished('tab-t1', { status: 'success', summary: '整理完成，共 3 个文件' })
      expect(mockDeliver).not.toHaveBeenCalled() // 防抖窗口内未投递

      vi.advanceTimersByTime(5000)

      expect(mockDeliver).toHaveBeenCalledTimes(1)
      expect(mockDeliver.mock.calls[0][0]).toContain('整理日志')
      expect(mockDeliver.mock.calls[0][0]).toContain('整理完成')
      const ctx = consumeProactiveContext(COMPANION)
      expect(ctx).toContain('tab-t1')
      expect(ctx).toContain('整理日志')
    })

    it('短时间多条完成/失败事件合并为一条复命', () => {
      vi.useFakeTimers()
      const host = makeHost([
        ['tab-t1', makeMockAgent({ title: '任务一' })],
        ['tab-t2', makeMockAgent({ title: '任务二' })]
      ])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished('tab-t1', { status: 'success', summary: '完成一' })
      vi.advanceTimersByTime(1000)
      supervisor.handleRunFinished('tab-t2', { status: 'failed', summary: '失败二' })
      vi.advanceTimersByTime(5000)

      expect(mockDeliver).toHaveBeenCalledTimes(1)
      const notice = mockDeliver.mock.calls[0][0]
      expect(notice).toContain('任务一')
      expect(notice).toContain('任务二')
    })

    it('联络自身完成不冒泡；watch/wakeup 不冒泡', () => {
      vi.useFakeTimers()
      const host = makeHost([[COMPANION, makeMockAgent({ title: '联络' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished(COMPANION, { status: 'success', summary: '联络回复完毕' })
      supervisor.handleRunFinished('__wakeup__', { status: 'success', summary: '心跳' })
      supervisor.handleRunFinished(undefined, { status: 'success', summary: '无属主' })
      supervisor.handleRunFinished('tab-t1:sub:explore', { status: 'success', summary: '帮手做完了' })
      vi.advanceTimersByTime(10000)

      expect(mockDeliver).not.toHaveBeenCalled()
      expect(consumeProactiveContext(COMPANION)).toBeUndefined()
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
      expect(host.prepareAssignedTask).toHaveBeenCalledWith(agentKey, '查日志', false)
      expect(host.say).toHaveBeenCalledTimes(1)
      const [agentId, message, context, opts] = host.say.mock.calls[0]
      expect(agentId).toBe(agentKey)
      expect(message).toBe('查一下昨天的错误日志')
      expect(context.terminalType).toBe('assistant')
      expect(opts.surface).toBe('assistant')
      expect(opts.config.executionMode).toBe('free')
    })

    it('没说全自动：这场走替我审批', async () => {
      const host = makeHost([])
      const supervisor = new TaskSupervisor(host)

      await supervisor.createTask({ title: '问个问题', brief: '简述项目结构' })

      expect(host.prepareAssignedTask).toHaveBeenCalledWith(expect.stringMatching(/^assistant-/), '问个问题', true)
    })
  })

  describe('flushPendingEvents', () => {
    it('立即冲刷挂起的复命，不等防抖窗口', async () => {
      vi.useFakeTimers()
      const host = makeHost([['tab-t1', makeMockAgent({ title: '整理日志' })]])
      const supervisor = new TaskSupervisor(host)

      supervisor.handleRunFinished('tab-t1', { status: 'success', summary: '整理完成' })
      expect(mockDeliver).not.toHaveBeenCalled()

      const flush = supervisor.flushPendingEvents()
      await vi.advanceTimersByTimeAsync(100)
      await flush

      expect(mockDeliver).toHaveBeenCalledTimes(1)
      expect(mockDeliver.mock.calls[0][0]).toContain('整理日志')
      expect(mockDeliver.mock.calls[0][1]).toMatchObject({ alwaysPersist: true })
    })

    it('空缓冲冲刷不投递', async () => {
      vi.useFakeTimers()
      const host = makeHost([])
      const supervisor = new TaskSupervisor(host)

      const flush = supervisor.flushPendingEvents()
      await vi.advanceTimersByTimeAsync(100)
      await flush

      expect(mockDeliver).not.toHaveBeenCalled()
    })
  })

  // ==================== proactive-store 追加语义 ====================

  describe('appendProactiveContext（复命与确认共用暂存）', () => {
    it('暂存上下文可追加且 consume 后清空', () => {
      addProactiveContext(COMPANION, '第一条', '标题一')
      // 通过 supervisor 事件再追加一条
      const host = makeHost([['tab-t1', makeMockAgent({ title: '任务一' })]])
      const supervisor = new TaskSupervisor(host)
      supervisor.handleNeedsConfirmation('tab-t1', {
        toolCallId: 'call-9', toolName: 'exec', riskLevel: 'dangerous', argsPreview: '{}'
      })

      const ctx = consumeProactiveContext(COMPANION)
      expect(ctx).toContain('第一条')
      expect(ctx).toContain('call-9')
      expect(consumeProactiveContext(COMPANION)).toBeUndefined()
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
        { surface: 'terminal', config: undefined }
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
        { surface: 'terminal', config: undefined }
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
