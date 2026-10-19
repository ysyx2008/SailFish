/**
 * manage_tasks 执行器单测：参数校验 + 转述制 confirm 只传达、不生成决定
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { manageTasks } from '../tools/task-manager'
import type { TaskSupervisor } from '../task-supervisor'
import type { ToolExecutorConfig } from '../tools/types'

function makeExecutor(supervisor: TaskSupervisor): ToolExecutorConfig {
  return {
    addStep: vi.fn(),
    taskSupervisor: supervisor,
  } as unknown as ToolExecutorConfig
}

function makeSupervisor(overrides: Partial<TaskSupervisor> = {}): TaskSupervisor {
  return {
    listTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0, page: 1, pageCount: 1, pageSize: 20 }),
    inspectTask: vi.fn().mockReturnValue(undefined),
    createTask: vi.fn().mockResolvedValue({ agentKey: 'assistant-new', fullAuto: false }),
    confirmTask: vi.fn().mockReturnValue({ ok: true, title: '部署服务' }),
    stopTask: vi.fn().mockReturnValue({ ok: true, title: '长跑任务' }),
    instructTask: vi.fn().mockResolvedValue({ ok: true, title: '查日志', delivered: 'next' }),
    isOwed: vi.fn().mockReturnValue(false),
    ...overrides,
  } as unknown as TaskSupervisor
}

/** 带「登记后台等待」能力的执行环境：用来看联络这一轮挂不挂着等 */
function makeWatchingExecutor(supervisor: TaskSupervisor) {
  const watches = new Map<string, unknown>()
  const executor = {
    addStep: vi.fn(),
    updateStep: vi.fn(),
    taskSupervisor: supervisor,
    trackBackgroundWatch: vi.fn((watch: { key: string }) => { watches.set(watch.key, watch) }),
    findBackgroundWatch: vi.fn((key: string) => watches.get(key)),
  } as unknown as ToolExecutorConfig
  return { executor, watches }
}

describe('manage_tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('无监督器时不可用', async () => {
    const result = await manageTasks({ action: 'list' }, { addStep: vi.fn() } as unknown as ToolExecutorConfig)
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('list 空列表返回成功', async () => {
    const supervisor = makeSupervisor()
    const result = await manageTasks({ action: 'list' }, makeExecutor(supervisor))
    expect(result.success).toBe(true)
    expect(supervisor.listTasks).toHaveBeenCalled()
  })

  it('list 把翻页、关键字、日期交给监督器；列表不报步数，后面还有就提示下一页', async () => {
    const supervisor = makeSupervisor({
      listTasks: vi.fn().mockResolvedValue({
        tasks: [
          { agentKey: 'tab-run', title: '跑着', terminalType: 'assistant', isRunning: true, currentToolName: 'exec', stepCount: 138 },
          { agentKey: 'assistant-old', title: '查日志', terminalType: 'assistant', isRunning: false, settled: 'completed' },
        ],
        total: 22, page: 2, pageCount: 2, pageSize: 20,
      }),
    } as Partial<TaskSupervisor>)
    const result = await manageTasks(
      { action: 'list', page: 2, query: ' 日志 ', start_date: '2026-10-08' },
      makeExecutor(supervisor)
    )
    expect(supervisor.listTasks).toHaveBeenCalledWith({ page: 2, keyword: '日志', startDate: '2026-10-08', endDate: undefined })
    expect(result.output).toContain('21. 「跑着」')
    expect(result.output).not.toContain('138')
    expect(result.output).not.toContain('page=3')
  })

  it('list 的页码写成文字也认，乱写就当第 1 页', async () => {
    const supervisor = makeSupervisor()
    await manageTasks({ action: 'list', page: '3' }, makeExecutor(supervisor))
    await manageTasks({ action: 'list', page: 'abc' }, makeExecutor(supervisor))
    expect(vi.mocked(supervisor.listTasks).mock.calls.map(([q]) => q?.page)).toEqual([3, undefined])
  })

  it('list 有筛选但没命中时说没有符合条件的', async () => {
    const supervisor = makeSupervisor()
    const result = await manageTasks({ action: 'list', query: '不存在' }, makeExecutor(supervisor))
    expect(result.output).toBe('没有符合条件的任务。')
  })

  it('create 缺 title/brief 失败', async () => {
    const supervisor = makeSupervisor()
    const missingTitle = await manageTasks({ action: 'create', brief: '做点事' }, makeExecutor(supervisor))
    expect(missingTitle.success).toBe(false)
    const missingBrief = await manageTasks({ action: 'create', title: '标题' }, makeExecutor(supervisor))
    expect(missingBrief.success).toBe(false)
    expect(supervisor.createTask).not.toHaveBeenCalled()
  })

  it('create 把用户声明的 full_auto 原样交给监督器', async () => {
    const supervisor = makeSupervisor()
    const result = await manageTasks(
      { action: 'create', title: '查日志', brief: '统计错误', full_auto: true },
      makeExecutor(supervisor)
    )
    expect(result.success).toBe(true)
    expect(supervisor.createTask).toHaveBeenCalledWith({
      title: '查日志',
      brief: '统计错误',
      fullAuto: true,
    })
  })

  it('confirm 只传达用户的 approve，不自行发明决定', async () => {
    const supervisor = makeSupervisor()
    const result = await manageTasks(
      { action: 'confirm', task_id: 'tab-1', tool_call_id: 'call-1', approve: false },
      makeExecutor(supervisor)
    )
    expect(result.success).toBe(true)
    expect(supervisor.confirmTask).toHaveBeenCalledWith('tab-1', 'call-1', false)
  })

  it('confirm 缺 approve 布尔值则拒绝执行', async () => {
    const supervisor = makeSupervisor()
    const result = await manageTasks(
      { action: 'confirm', task_id: 'tab-1', tool_call_id: 'call-1' },
      makeExecutor(supervisor)
    )
    expect(result.success).toBe(false)
    expect(supervisor.confirmTask).not.toHaveBeenCalled()
  })

  it('迟到的 confirm 如实告知已处理', async () => {
    const supervisor = makeSupervisor({
      confirmTask: vi.fn().mockReturnValue({ ok: false, reason: 'confirmation_stale', title: '部署服务' }),
    })
    const result = await manageTasks(
      { action: 'confirm', task_id: 'tab-1', tool_call_id: 'call-1', approve: true },
      makeExecutor(supervisor)
    )
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('stop 缺 task_id 失败', async () => {
    const supervisor = makeSupervisor()
    const result = await manageTasks({ action: 'stop' }, makeExecutor(supervisor))
    expect(result.success).toBe(false)
    expect(supervisor.stopTask).not.toHaveBeenCalled()
  })

  it('未知 action 失败', async () => {
    const supervisor = makeSupervisor()
    const result = await manageTasks({ action: 'explode' }, makeExecutor(supervisor))
    expect(result.success).toBe(false)
  })

  it('步骤标题用当前语言的动作名', async () => {
    const supervisor = makeSupervisor()
    const listExec = makeExecutor(supervisor)
    await manageTasks({ action: 'list' }, listExec)
    expect(vi.mocked(listExec.addStep).mock.calls[0][0]).toMatchObject({
      type: 'tool_call',
      content: '任务管理：查看任务列表',
    })

    const inspectExec = makeExecutor(supervisor)
    await manageTasks({ action: 'inspect', task_id: 'tab-1' }, inspectExec)
    expect(vi.mocked(inspectExec.addStep).mock.calls[0][0]).toMatchObject({
      type: 'tool_call',
      content: '任务管理：查看任务近况',
    })

    const createExec = makeExecutor(supervisor)
    await manageTasks({ action: 'create', title: '查日志', brief: '统计错误' }, createExec)
    expect(vi.mocked(createExec.addStep).mock.calls[0][0]).toMatchObject({
      type: 'tool_call',
      content: '任务管理：创建任务「查日志」',
    })

    const unknownExec = makeExecutor(supervisor)
    await manageTasks({ action: 'explode' }, unknownExec)
    expect(vi.mocked(unknownExec.addStep).mock.calls[0][0]).toMatchObject({
      type: 'tool_call',
      content: '任务管理：explode',
    })
  })

  it('instruct 把这一句交给监督器', async () => {
    const supervisor = makeSupervisor()
    const missing = await manageTasks({ action: 'instruct', task_id: 'tab-1' }, makeExecutor(supervisor))
    expect(missing.success).toBe(false)
    const result = await manageTasks(
      { action: 'instruct', task_id: 'tab-1', message: '再补一段' },
      makeExecutor(supervisor)
    )
    expect(result.success).toBe(true)
    expect(supervisor.instructTask).toHaveBeenCalledWith('tab-1', '再补一段')
  })

  describe('派出任务后这一轮等不等回执', () => {
    it('create：欠着回执就登记一份等待，并告诉联络这一轮会等', async () => {
      const supervisor = makeSupervisor({ isOwed: vi.fn().mockReturnValue(true) })
      const { executor, watches } = makeWatchingExecutor(supervisor)

      const result = await manageTasks({ action: 'create', title: '查日志', brief: '统计错误' }, executor)

      expect(result.success).toBe(true)
      expect([...watches.keys()]).toEqual(['task:assistant-new'])
      expect(result.output).toContain('这一轮在它交回执之前不会结束')
    })

    it('create：执行环境没有登记等待的能力时不登记，如实说这一轮不等', async () => {
      const supervisor = makeSupervisor({ isOwed: vi.fn().mockReturnValue(true) })

      const result = await manageTasks({ action: 'create', title: '查日志', brief: '统计错误' }, makeExecutor(supervisor))

      expect(result.output).toContain('这一轮不会等它')
    })

    it('instruct：再交代同一场，沿用原来那份等待，不重复登记', async () => {
      const supervisor = makeSupervisor({
        isOwed: vi.fn().mockReturnValue(true),
        instructTask: vi.fn().mockResolvedValue({ ok: true, title: '查日志', delivered: 'now' }),
      })
      const { executor, watches } = makeWatchingExecutor(supervisor)

      await manageTasks({ action: 'create', title: '查日志', brief: '统计错误' }, executor)
      const first = [...watches.values()][0]
      await manageTasks({ action: 'instruct', task_id: 'assistant-new', message: '再补一段' }, executor)

      expect(executor.trackBackgroundWatch).toHaveBeenCalledTimes(1)
      expect([...watches.values()][0]).toBe(first)
    })

    it('instruct：那场不欠联络回执（用户开头的那一轮）时不登记，也不提等回执', async () => {
      const supervisor = makeSupervisor({
        isOwed: vi.fn().mockReturnValue(false),
        instructTask: vi.fn().mockResolvedValue({ ok: true, title: '查日志', delivered: 'now' }),
      })
      const { executor, watches } = makeWatchingExecutor(supervisor)

      const result = await manageTasks({ action: 'instruct', task_id: 'tab-1', message: '补一句' }, executor)

      expect(watches.size).toBe(0)
      expect(result.output).not.toContain('回执')
    })
  })
})
