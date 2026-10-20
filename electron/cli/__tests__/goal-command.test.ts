import { describe, expect, it, vi } from 'vitest'
import type { GoalContract } from '@shared/types'
import { CliGoalCommand, type GoalPort } from '../goal-command'

function goal(patch: Partial<GoalContract> = {}): GoalContract {
  return {
    goalId: 'g1',
    objective: '把测试跑绿',
    status: 'active',
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

/** 一个会记账的假后端：只实现命令行会用到的那几个动作 */
function fakePort(initial?: GoalContract) {
  const state: { goal?: GoalContract } = { goal: initial }
  const port: GoalPort = {
    getGoal: vi.fn(() => state.goal),
    setGoal: vi.fn(({ objective }) => {
      state.goal = goal({ goalId: `g${Math.random()}`, objective })
      return { ok: true as const, goal: state.goal }
    }),
    pauseGoal: vi.fn(() => {
      if (!state.goal) return { ok: false as const, error: 'no_goal' }
      if (state.goal.status !== 'active') return { ok: false as const, error: 'not_active' }
      state.goal = { ...state.goal, status: 'paused' }
      return { ok: true as const, goal: state.goal }
    }),
    resumeGoal: vi.fn(async () => {
      if (!state.goal) return { ok: false as const, error: 'no_goal' }
      state.goal = { ...state.goal, status: 'active' }
      return { ok: true as const, goal: state.goal }
    }),
    clearGoal: vi.fn(() => {
      if (!state.goal) return { ok: false as const, error: 'no_goal' }
      state.goal = undefined
      return { ok: true as const }
    }),
    editGoal: vi.fn(({ objective }) => {
      if (!state.goal) return { ok: false as const, error: 'no_goal' }
      state.goal = { ...state.goal, objective }
      return { ok: true as const, goal: state.goal }
    }),
  }
  return { port, state }
}

function command(port: GoalPort, opts: { interactive?: boolean; answer?: boolean } = {}) {
  const confirm = vi.fn(async () => opts.answer ?? true)
  const cmd = new CliGoalCommand(port, {
    agentKey: 'pty-1',
    terminalType: 'local',
    interactive: opts.interactive ?? true,
    confirm,
  })
  return { cmd, confirm }
}

describe('CliGoalCommand 看状态', () => {
  it('没有目标：说明用法', async () => {
    const { cmd } = command(fakePort().port)
    const out = await cmd.apply('')
    expect(out.notes[0]).toContain('还没有目标')
    expect(out.notes[1]).toContain('/goal')
  })

  it('有目标：给出正文、状态、用时和用量', async () => {
    const { port } = fakePort(goal({ status: 'paused', timeUsedSeconds: 192, tokensUsed: 2400 }))
    const { cmd } = command(port)
    const out = await cmd.apply('')
    expect(out.notes).toEqual(['目标：把测试跑绿', '状态：已暂停 · 用时 3m 12s · 2.4K tokens'])
  })
})

describe('CliGoalCommand 挂目标', () => {
  it('新目标：挂上并要求以 /goal 开一轮', async () => {
    const { port } = fakePort()
    const { cmd, confirm } = command(port)
    const out = await cmd.apply('把设置页文案检查一遍')
    expect(port.setGoal).toHaveBeenCalledWith({
      agentKey: 'pty-1',
      terminalType: 'local',
      objective: '把设置页文案检查一遍',
      replace: false,
    })
    expect(out.say).toBe('/goal 把设置页文案检查一遍')
    expect(out.notes[0]).toContain('已挂上目标')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('以 clear、pause 开头的一句话是目标正文，不是命令', async () => {
    const { port } = fakePort()
    const { cmd } = command(port)
    const out = await cmd.apply('clear 掉缓存目录并重建索引')
    expect(out.say).toBe('/goal clear 掉缓存目录并重建索引')
    expect(port.clearGoal).not.toHaveBeenCalled()
  })

  it('已有没做完的目标：问了才换', async () => {
    const { port } = fakePort(goal())
    const yes = command(port, { answer: true })
    const out = await yes.cmd.apply('换一个')
    expect(yes.confirm).toHaveBeenCalledOnce()
    expect(port.setGoal).toHaveBeenCalledWith(expect.objectContaining({ replace: true }))
    expect(out.say).toBe('/goal 换一个')
  })

  it('已有没做完的目标：答不换就保持原样', async () => {
    const { port, state } = fakePort(goal())
    const no = command(port, { answer: false })
    const out = await no.cmd.apply('换一个')
    expect(out.say).toBeUndefined()
    expect(port.setGoal).not.toHaveBeenCalled()
    expect(state.goal?.objective).toBe('把测试跑绿')
  })

  it('已有没做完的目标、没有交互终端：不替人答应', async () => {
    const { port } = fakePort(goal())
    const { cmd, confirm } = command(port, { interactive: false })
    const out = await cmd.apply('换一个')
    expect(confirm).not.toHaveBeenCalled()
    expect(out.say).toBeUndefined()
    expect(port.setGoal).not.toHaveBeenCalled()
    expect(out.notes[0]).toContain('没有交互终端')
  })

  it('已达成的目标上直接挂新的，不用问', async () => {
    const { port } = fakePort(goal({ status: 'achieved' }))
    const { cmd, confirm } = command(port)
    const out = await cmd.apply('下一件事')
    expect(confirm).not.toHaveBeenCalled()
    expect(out.say).toBe('/goal 下一件事')
  })

  it('后端拒绝时把原因说清', async () => {
    const { port } = fakePort()
    port.setGoal = vi.fn(() => ({ ok: false as const, error: 'not_supported' }))
    const { cmd } = command(port)
    const out = await cmd.apply('随便')
    expect(out.say).toBeUndefined()
    expect(out.notes[0]).toContain('不能挂目标')
  })
})

describe('CliGoalCommand 管理', () => {
  it('pause：推进中的暂停；没有目标时说没有', async () => {
    const withGoal = command(fakePort(goal()).port)
    expect((await withGoal.cmd.apply('pause')).notes).toEqual(['已暂停目标。'])
    const none = command(fakePort().port)
    expect((await none.cmd.apply('pause')).notes[0]).toContain('还没有目标')
  })

  it('resume：交给调用方在「忙」的状态里去跑，跑完说话', async () => {
    const { port } = fakePort(goal({ status: 'paused' }))
    const { cmd } = command(port)
    const ctx = { terminalOutput: [], systemInfo: { os: 'darwin', shell: 'zsh' }, terminalType: 'local' } as never
    const out = await cmd.apply('resume', ctx)
    expect(out.resume).toBeTypeOf('function')
    expect(port.resumeGoal).not.toHaveBeenCalled()
    expect(await out.resume!()).toEqual([])
    expect(port.resumeGoal).toHaveBeenCalledWith({ agentKey: 'pty-1', terminalType: 'local', context: ctx })
  })

  it('resume 被拒：说清为什么', async () => {
    const { port } = fakePort(goal({ status: 'paused' }))
    port.resumeGoal = vi.fn(async () => ({ ok: false as const, error: 'budget_exhausted' }))
    const { cmd } = command(port)
    const out = await cmd.apply('resume')
    expect((await out.resume!())[0]).toContain('没法继续')
  })

  it('clear：没做完的先问，答否就不清', async () => {
    const { port, state } = fakePort(goal())
    const no = command(port, { answer: false })
    expect((await no.cmd.apply('clear')).notes).toEqual(['没清除。'])
    expect(state.goal).toBeDefined()

    const yes = command(port, { answer: true })
    expect((await yes.cmd.apply('clear')).notes).toEqual(['已清除目标。'])
    expect(state.goal).toBeUndefined()
  })

  it('clear：已达成的直接收起，不问', async () => {
    const { port, state } = fakePort(goal({ status: 'achieved' }))
    const { cmd, confirm } = command(port)
    expect((await cmd.apply('clear')).notes).toEqual(['已清除目标。'])
    expect(confirm).not.toHaveBeenCalled()
    expect(state.goal).toBeUndefined()
  })

  it('clear：没有交互终端时不替人答应', async () => {
    const { port, state } = fakePort(goal())
    const { cmd, confirm } = command(port, { interactive: false })
    expect((await cmd.apply('clear')).notes[0]).toContain('没有交互终端')
    expect(confirm).not.toHaveBeenCalled()
    expect(state.goal).toBeDefined()
  })

  it('edit：要有新正文；改完说出新正文', async () => {
    const { port } = fakePort(goal())
    const { cmd } = command(port)
    expect((await cmd.apply('edit')).notes[0]).toContain('需要写新的正文')
    expect(port.editGoal).not.toHaveBeenCalled()
    expect((await cmd.apply('edit 把测试跑绿并补上覆盖率')).notes).toEqual(['已改目标：把测试跑绿并补上覆盖率'])
  })

  it('edit 已达成的：说明不能改', async () => {
    const { port } = fakePort(goal({ status: 'achieved' }))
    port.editGoal = vi.fn(() => ({ ok: false as const, error: 'terminal' }))
    const { cmd } = command(port)
    expect((await cmd.apply('edit 新的')).notes[0]).toContain('不能改写')
  })
})

describe('CliGoalCommand 收工时说一句', () => {
  it('达成：写状态、用时、用量；同一状态不重复说', () => {
    const { port, state } = fakePort(goal({ status: 'achieved', timeUsedSeconds: 75, tokensUsed: 1_912_345 }))
    const { cmd } = command(port)
    expect(cmd.reportAfterTurn()[0]).toBe('目标已达成 · 用时 1m 15s · 1.9M tokens')
    expect(cmd.reportAfterTurn()).toEqual([])
    state.goal = { ...state.goal!, tokensUsed: 2_000_000 }
    expect(cmd.reportAfterTurn()).toHaveLength(2)
  })

  it('没做完：告诉下一步怎么接着推', () => {
    const { port } = fakePort(goal({ status: 'paused', timeUsedSeconds: 8 }))
    const { cmd } = command(port)
    const lines = cmd.reportAfterTurn()
    expect(lines[0]).toBe('目标已暂停 · 用时 8s')
    expect(lines[1]).toContain('/goal resume')
  })

  it('不能再敲一行的时候不写「下一步」', () => {
    const { port } = fakePort(goal({ status: 'blocked' }))
    const { cmd } = command(port, { interactive: false })
    const lines = cmd.reportAfterTurn()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('停滞')
  })

  it('没有目标时什么也不说', () => {
    const { cmd } = command(fakePort().port)
    expect(cmd.reportAfterTurn()).toEqual([])
  })

  it('继续之后即使用量没变也要说一次结果', async () => {
    const { port } = fakePort(goal({ status: 'paused' }))
    const { cmd } = command(port)
    expect(cmd.reportAfterTurn()).toHaveLength(2)
    const out = await cmd.apply('resume')
    await out.resume!()
    expect(cmd.reportAfterTurn().length).toBeGreaterThan(0)
  })
})
