/**
 * 花名册把每位的状态变化交给各自的存盘人：开工、做完、失败、被打断、再叫起来。
 */
import { describe, it, expect } from 'vitest'
import { SubAgentRoster, type ChildAgentHandle, type RosterSpawnDeps } from '../sub-agent-roster'
import type { ChildRecorder, ChildStateInput } from '../../history/sub-agent-record-store'
import type { AgentContext } from '../types'
import type { AiMessage } from '../../ai.service'

const context: AgentContext = {
  terminalOutput: [],
  systemInfo: { os: 'darwin', shell: 'zsh' },
  terminalType: 'assistant',
  cwd: '/tmp',
}

interface FakeRecorder {
  states: ChildStateInput[]
  openings: AiMessage[][]
}

function fakeRecorder(): FakeRecorder & ChildRecorder {
  const states: ChildStateInput[] = []
  const openings: AiMessage[][] = []
  return {
    states,
    openings,
    saveState: (input: ChildStateInput) => { states.push({ ...input }) },
    noteOpening: (seed: readonly AiMessage[]) => { openings.push([...seed]) },
    saveRecord: () => {},
    noteInterruptedCalls: () => {},
  } as unknown as FakeRecorder & ChildRecorder
}

function child(opts: { result?: string; fail?: string; hang?: boolean }, recorder?: ChildRecorder): ChildAgentHandle {
  let aborted = false
  let release: (() => void) | undefined
  return {
    childRecorder: recorder,
    isRunning: () => false,
    abort: () => { aborted = true; release?.(); return true },
    addUserMessage: () => true,
    seedOpeningMessages: () => {},
    async run() {
      if (opts.hang) await new Promise<void>(resolve => { release = resolve })
      if (aborted) throw new Error('aborted')
      if (opts.fail) throw new Error(opts.fail)
      return opts.result ?? 'done'
    },
  }
}

function deps(create: (name: string) => ChildAgentHandle): RosterSpawnDeps {
  return {
    createChild: create,
    getParentMessages: () => [{ role: 'user', content: '查 nginx' }, { role: 'assistant', content: '好' }],
    getParentContext: () => context,
    knock: () => {},
    onProgress: () => {},
    isParentAborted: () => false,
    sanitize: messages => [...messages],
    formatKnock: snap => `knock:${snap.name}`,
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('花名册把状态变化交给存盘人', () => {
  it('开工时记下开局和「在干」，做完时记下结果', async () => {
    const recorder = fakeRecorder()
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    roster.spawn([{ name: 'alice', description: '读配置', prompt: '去读', role: '测试专家' }], deps(() => child({ result: '端口 8848' }, recorder)))

    expect(recorder.openings).toEqual([[{ role: 'user', content: '查 nginx' }, { role: 'assistant', content: '好' }]])
    expect(recorder.states[0]).toMatchObject({ name: 'alice', status: 'running', description: '读配置', prompt: '去读', role: '测试专家' })

    await settle()
    expect(recorder.states.at(-1)).toMatchObject({ status: 'completed', result: '端口 8848' })
  })

  it('失败时记下原因', async () => {
    const recorder = fakeRecorder()
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    roster.spawn([{ name: 'alice', description: 'x', prompt: 'y' }], deps(() => child({ fail: '模型接口 500' }, recorder)))
    await settle()
    expect(recorder.states.at(-1)).toMatchObject({ status: 'failed', error: '模型接口 500' })
  })

  it('主人这一轮收工把还在干的都标成被中断，当场就记下', async () => {
    const recorders = { alice: fakeRecorder(), bob: fakeRecorder() }
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    roster.spawn(
      [{ name: 'alice', description: 'a', prompt: 'a' }, { name: 'bob', description: 'b', prompt: 'b' }],
      deps(name => child(name === 'alice' ? { hang: true } : { result: '好了' }, recorders[name as 'alice' | 'bob'])),
    )
    await settle()
    expect(recorders.bob.states.at(-1)?.status).toBe('completed')

    roster.abortAll()
    expect(recorders.alice.states.at(-1)).toMatchObject({ status: 'interrupted' })
    // 做完的不动
    expect(recorders.bob.states.at(-1)?.status).toBe('completed')
  })

  it('用户点名打断一位：记成被中断，带上「已打断」', async () => {
    const recorder = fakeRecorder()
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    roster.spawn([{ name: 'alice', description: 'a', prompt: 'a' }], deps(() => child({ hang: true }, recorder)))
    roster.interrupt('alice')
    await settle()
    expect(recorder.states.at(-1)).toMatchObject({ status: 'interrupted', error: '已打断' })
  })

  it('没有存盘人的伙计照常干活，不报错', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    roster.spawn([{ name: 'alice', description: 'a', prompt: 'a' }], deps(() => child({ result: '好了' })))
    await settle()
    expect(roster.get('alice')?.status).toBe('completed')
  })
})
