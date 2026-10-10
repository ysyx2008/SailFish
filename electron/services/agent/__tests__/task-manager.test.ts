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
    listSupervisedTasks: vi.fn().mockReturnValue([]),
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
    expect(supervisor.listSupervisedTasks).toHaveBeenCalled()
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
