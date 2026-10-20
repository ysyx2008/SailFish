/**
 * 任务目标的读取：别场对话的查询不能动正在跑的这场；落盘里还写着「推进中」的目标，读出来是已暂停。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { AgentService } from '../index'
import { GoalContract } from '../goal/goal-contract'

function startGoal(): GoalContract {
  const started = GoalContract.start('把测试跑绿')
  if ('error' in started) throw new Error(started.error)
  return started
}

function serviceWith(agent: Record<string, unknown>, storedGoal?: unknown) {
  const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as never
  const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as never
  const service = new AgentService(ai, pty)
  vi.spyOn(service, 'getOrCreateAgent').mockReturnValue(agent as never)
  ;(service as unknown as { services: Record<string, unknown> }).services.conversationManager = {
    getRecord: () => (storedGoal ? { goal: storedGoal } : undefined),
  }
  return service
}

describe('AgentService 读取目标', () => {
  it('正在跑的这场，被问到别场的目标时不换掉自己的会话', () => {
    const live = startGoal()
    const ensureConversation = vi.fn()
    const agent = {
      isRunning: () => true,
      getSessionId: () => 'sess_live',
      getGoal: () => live,
      ensureConversation,
    }
    const service = serviceWith(agent)

    expect(service.getGoal('tab-1', 'sess_other')).toBeUndefined()
    expect(ensureConversation).not.toHaveBeenCalled()
    expect(service.getGoal('tab-1', 'sess_live')?.goalId).toBe(live.goalId)
  })

  it('不在跑、落盘里还写着推进中的目标：读出来是已暂停', () => {
    const stored = startGoal().snapshot()
    expect(stored.status).toBe('active')
    const agent = {
      isRunning: () => false,
      getSessionId: () => undefined,
      getGoal: () => undefined,
      ensureConversation: vi.fn(),
    }
    const service = serviceWith(agent, stored)
    // 查的是历史里的另一场：Agent 里没有这场的目标，只剩落盘那份
    const resolveSpy = vi.spyOn(service as unknown as { resolveGoalAgent: () => unknown }, 'resolveGoalAgent')
    resolveSpy.mockReturnValue(undefined)

    const read = service.getGoal('tab-1', 'sess_old')
    expect(read?.goalId).toBe(stored.goalId)
    expect(read?.status).toBe('paused')
  })
})
