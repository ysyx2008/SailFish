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
    ...overrides,
  } as unknown as TaskSupervisor
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
})
