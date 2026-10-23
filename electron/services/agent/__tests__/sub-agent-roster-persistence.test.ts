/**
 * 花名册把每位的状态变化交给各自的存盘人：开工、做完、失败、被打断、再叫起来。
 */
import { describe, it, expect } from 'vitest'
import { MAX_LIVE_CHILDREN, SubAgentRoster, toolStepsFromRecords, type ChildAgentHandle, type DormantChild, type RosterSpawnDeps } from '../sub-agent-roster'
import { resumeNoticeFor } from '../tools/sub-agent'
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

  it('settled：被中止的伙计都收尾（该写的盘写完）后才兑现；已经收尾的立刻兑现', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    await expect(roster.settled()).resolves.toBeUndefined()

    let finishedWriting = false
    roster.spawn([{ name: 'alice', description: 'a', prompt: 'a' }], deps(() => {
      const handle = child({ hang: true })
      // 中止后还要一会儿才收尾：收尾时的最后一次写盘在这之后
      return {
        ...handle,
        abort: () => { setTimeout(() => handle.abort(), 30); return true },
        async run(...args: Parameters<ChildAgentHandle['run']>) {
          try { return await handle.run(...args) } finally { finishedWriting = true }
        },
      }
    }))
    roster.abortAll()
    expect(finishedWriting).toBe(false)
    await roster.settled()
    expect(finishedWriting).toBe(true)
  })

  it('没有存盘人的伙计照常干活，不报错', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    roster.spawn([{ name: 'alice', description: 'a', prompt: 'a' }], deps(() => child({ result: '好了' })))
    await settle()
    expect(roster.get('alice')?.status).toBe('completed')
  })
})

function sleeper(name: string, over: Partial<DormantChild> = {}, handle?: ChildAgentHandle & { ran?: string[] }): DormantChild {
  return {
    name,
    description: `${name} 的活`,
    prompt: `我是${name}`,
    status: 'interrupted',
    result: '上次的结果',
    revive: () => ({ handle: handle ?? child({ result: '接着做完了' }), steps: [{ tool: 'exec', args: 'npm i', status: 'completed' }] }),
    ...over,
  }
}

describe('花名册里的休眠伙计', () => {
  it('只在第一次要用时读一次盘；休眠的不占名额、不进名单', () => {
    let reads = 0
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const d = deps(() => child({ result: 'x' }))
    d.restoreDormant = () => { reads++; return [sleeper('alice'), sleeper('bob', { status: 'completed' })] }
    roster.spawn([{ description: '新活', prompt: 'p' }], d)
    roster.spawn([{ description: '又一个', prompt: 'p' }], d)
    expect(reads).toBe(1)
    expect(roster.list().map(c => c.name)).not.toContain('alice')
    expect(roster.liveCount()).toBeLessThanOrEqual(2)
    expect(roster.room()).toBeGreaterThanOrEqual(MAX_LIVE_CHILDREN - 2)
  })

  it('新派的人不能和休眠的重名（同名会把盘上的对话盖掉）', () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const d = deps(() => child({ result: 'x' }))
    d.restoreDormant = () => [sleeper('reader')]
    const names = roster.spawn([{ description: 'reader', prompt: 'p' }, { name: 'reader', description: 'z', prompt: 'p' }], d)
    expect(names).toEqual(['reader-2', 'reader-3'])
  })

  it('点名再交代：叫醒他，话前面带上上次的情形，卡片上有以前的步骤，存盘人记下「在干」', async () => {
    const recorder = fakeRecorder()
    const sent: string[] = []
    const handle = child({ result: '接着做完了' }, recorder)
    const originalRun = handle.run.bind(handle)
    handle.run = async (message, context, options) => { sent.push(message); return originalRun(message, context, options) }

    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const d = deps(() => child({}))
    d.restoreDormant = () => [sleeper('alice', {}, handle)]
    d.resumeNotice = resumeNoticeFor

    const result = roster.followup('alice', '换个办法', d)
    expect(result).toEqual({ ok: true })
    expect(roster.get('alice')).toMatchObject({ status: 'running', result: '上次的结果' })
    expect(roster.get('alice')!.steps).toEqual([{ tool: 'exec', args: 'npm i', status: 'completed' }])
    expect(recorder.states[0]).toMatchObject({ name: 'alice', status: 'running' })

    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('[上次的情形]')
    expect(sent[0].endsWith('换个办法')).toBe(true)
    expect(roster.get('alice')).toMatchObject({ status: 'completed', result: '接着做完了' })
  })

  it('做完的休眠伙计被再交代，不带「上次的情形」', async () => {
    const sent: string[] = []
    const handle = child({ result: '好' })
    const originalRun = handle.run.bind(handle)
    handle.run = async (message, context, options) => { sent.push(message); return originalRun(message, context, options) }
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const d = deps(() => child({}))
    d.restoreDormant = () => [sleeper('alice', { status: 'completed' }, handle)]
    d.resumeNotice = resumeNoticeFor
    expect(roster.followup('alice', '再补一条', d)).toEqual({ ok: true })
    await settle()
    expect(sent).toEqual(['再补一条'])
  })

  it('对休眠的老伙计用打断：说他已经不在跑了，不说没有这个人', () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const restoreDormant = () => [sleeper('alice')]
    expect(roster.interrupt('alice', { restoreDormant })).toEqual({ ok: false, error: 'alice 已经不在跑了' })
    expect(roster.interrupt('nobody', { restoreDormant })).toEqual({ ok: false, error: '没有叫 nobody 的伙计' })
  })

  it('没有这个名字的老伙计：照旧说没有', () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const d = deps(() => child({}))
    d.restoreDormant = () => [sleeper('alice')]
    expect(roster.followup('nobody', 'x', d)).toEqual({ ok: false, error: '没有叫 nobody 的伙计' })
  })

  it('叫醒时对话读不回来：说清楚，伙计仍然休眠', () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const d = deps(() => child({}))
    d.restoreDormant = () => [sleeper('alice', { revive: () => { throw new Error('文件坏了') } })]
    const result = roster.followup('alice', 'x', d)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('文件坏了')
    expect(roster.get('alice')).toBeUndefined()
  })

  it('主人这一轮已经被中止：不叫醒', () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const d = { ...deps(() => child({})), isParentAborted: () => true }
    d.restoreDormant = () => [sleeper('alice')]
    expect(roster.followup('alice', 'x', d)).toEqual({ ok: false, error: '已中止' })
  })
})

describe('叫醒时告诉伙计上次的情形', () => {
  it('做完的没有话说', () => {
    expect(resumeNoticeFor(sleeper('a', { status: 'completed' }))).toBe('')
  })

  it('被中断：说中断，并列出没记录结果的调用（只给事实，不下命令）', () => {
    const text = resumeNoticeFor(sleeper('a', { interruptedCalls: [{ tool: 'exec', target: 'npm install' }, { tool: 'write_text_file' }] }))
    expect(text).toContain('被中断')
    expect(text).toContain('2 个工具调用没有记录结果：exec npm install、write_text_file')
    expect(text).toContain('磁盘上的现状可能已经变了')
  })

  it('出错停下：带上原因', () => {
    expect(resumeNoticeFor(sleeper('a', { status: 'failed', error: '模型接口 500' }))).toContain('模型接口 500')
  })

  it('程序异常退出：说最后一轮不明', () => {
    const text = resumeNoticeFor(sleeper('a', { abnormalExit: true }))
    expect(text).toContain('异常退出')
    expect(text).toContain('最后一轮')
  })

  it('没记录结果的调用很多时只列前几个，过长的对象截断', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ tool: 'exec', target: `cmd-${i}` }))
    const text = resumeNoticeFor(sleeper('a', { interruptedCalls: many }))
    expect(text).toContain('8 个工具调用')
    expect(text).toContain('cmd-4…')
    expect(text).not.toContain('cmd-5')
    const long = resumeNoticeFor(sleeper('a', { interruptedCalls: [{ tool: 'exec', target: 'x'.repeat(200) }] }))
    expect(long).toContain(`${'x'.repeat(80)}…`)
    expect(long).not.toContain('x'.repeat(81))
  })
})

describe('按盘上的步骤记录重建卡片', () => {
  it('同一条调用的「开始」和「结果」并成一行，非工具步骤不进卡片', () => {
    const steps = toolStepsFromRecords([
      { id: 's1', type: 'user_task' },
      { id: 't1', type: 'tool_call', toolName: 'exec', toolArgs: { command: 'ls' } },
      { id: 't1', type: 'tool_call', toolName: 'exec', toolArgs: { command: 'ls' }, success: true, toolResult: 'a b' },
      { id: 't2', type: 'tool_call', toolName: 'read_file', toolArgs: { path: '/x' }, success: false, toolResult: '没有这个文件' },
      { id: 's2', type: 'final_result' },
    ])
    expect(steps).toEqual([
      { id: 't1', tool: 'exec', args: 'ls', status: 'completed', result: 'a b' },
      { id: 't2', tool: 'read_file', args: '/x', status: 'failed', result: '没有这个文件' },
    ])
  })
})
