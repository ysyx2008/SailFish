import { describe, it, expect } from 'vitest'
import { runUntilIdle } from '../run-until-idle'
import { SubAgentRoster, allocateChildName, type ChildAgentHandle } from '../sub-agent-roster'
import type { AgentContext } from '../types'
import type { AiMessage } from '../../ai.service'

const context: AgentContext = {
  terminalOutput: [],
  systemInfo: { os: 'darwin', shell: 'zsh' },
  terminalType: 'assistant',
  cwd: '/tmp',
}

function stubChild(opts: {
  delayMs: number
  result?: string
  fail?: string
}): ChildAgentHandle & { messages: string[]; seeded: unknown[] } {
  let running = false
  let aborted = false
  const messages: string[] = []
  const seeded: unknown[] = []
  return {
    messages,
    seeded,
    isRunning: () => running,
    abort: () => {
      aborted = true
      running = false
      return true
    },
    addUserMessage: (message: string) => {
      messages.push(message)
      return true
    },
    seedOpeningMessages: (messages) => {
      seeded.splice(0, seeded.length, ...messages)
    },
    async run(message: string) {
      running = true
      messages.push(message)
      await new Promise(resolve => setTimeout(resolve, opts.delayMs))
      running = false
      if (aborted) throw new Error('aborted')
      if (opts.fail) throw new Error(opts.fail)
      return opts.result ?? 'done'
    }
  }
}

describe('runUntilIdle', () => {
  it('派出后模型不再调工具、伙计稍后完成——主人必须接到结果再收工', async () => {
    const knocks: string[] = []
    const roster = new SubAgentRoster()
    let pending = false
    let loops = 0

    const child = stubChild({ delayMs: 40, result: '配置在 /etc/nginx' })
    const names = roster.spawn(
      [{ description: '读配置', prompt: '去读 nginx 配置' }],
      {
        createChild: () => child,
        getParentMessages: () => [
          { role: 'user', content: '查 nginx' },
          { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'dispatch_agents', arguments: '{}' } }] },
        ],
        getParentContext: () => context,
        knock: (message) => {
          knocks.push(message)
          pending = true
        },
        onProgress: () => {},
        isParentAborted: () => false,
        sanitize: (messages) => messages.filter(m => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls)),
        formatKnock: (snap) => `knock:${snap.name}:${snap.result}`,
      }
    )

    expect(names).toHaveLength(1)
    expect(roster.hasLive()).toBe(true)

    const result = await runUntilIdle({
      executeLoop: async () => {
        loops++
        if (loops === 1) return '我先派人'
        return `收到 ${knocks[0]}`
      },
      hasPendingMessages: () => pending && loops === 1 ? (pending = false, true) : pending,
      hasLiveChildren: () => roster.hasLive(),
      waitForChildrenOrKnock: () => roster.waitForKnock(new AbortController().signal),
      isAborted: () => false,
    })

    expect(loops).toBe(2)
    expect(result).toContain('配置在 /etc/nginx')
    expect(roster.hasLive()).toBe(false)
    expect(child.messages[0]).toBe('去读 nginx 配置')
  })

  it('用户停止会级联打断活着的伙计', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild({ delayMs: 5000, result: 'too late' })
    roster.spawn(
      [{ description: '慢任务', prompt: '慢慢做' }],
      {
        createChild: () => child,
        getParentMessages: () => [] as AiMessage[],
        getParentContext: () => context,
        knock: () => {},
        onProgress: () => {},
        isParentAborted: () => false,
        sanitize: () => [] as AiMessage[],
        formatKnock: () => 'knock',
      }
    )
    expect(roster.hasLive()).toBe(true)
    roster.abortAll()
    expect(roster.hasLive()).toBe(false)
    expect(roster.list()[0].status).toBe('interrupted')
    expect(child.isRunning()).toBe(false)
  })
})

describe('interrupt', () => {
  it('打断进行中的伙计时仍算活着，直到它收干净再敲门', async () => {
    const knocks: string[] = []
    const roster = new SubAgentRoster()
    const child = stubChild({ delayMs: 80, result: 'too late' })
    roster.spawn(
      [{ name: 'alice', description: '慢任务', prompt: '慢慢做' }],
      {
        createChild: () => child,
        getParentMessages: () => [] as AiMessage[],
        getParentContext: () => context,
        knock: (message) => knocks.push(message),
        onProgress: () => {},
        isParentAborted: () => false,
        sanitize: () => [] as AiMessage[],
        formatKnock: (snap) => `knock:${snap.name}:${snap.status}`,
      }
    )
    expect(roster.interrupt('alice').ok).toBe(true)
    expect(roster.hasLive()).toBe(true)
    await roster.waitUntil(['alice'], new AbortController().signal)
    expect(roster.hasLive()).toBe(false)
    expect(roster.get('alice')?.status).toBe('interrupted')
    expect(knocks).toEqual(['knock:alice:interrupted'])
  })
})

describe('waitUntil', () => {
  function spawnDeps(roster: SubAgentRoster, createChild: () => ChildAgentHandle) {
    return {
      createChild,
      getParentMessages: () => [] as AiMessage[],
      getParentContext: () => context,
      knock: () => {},
      onProgress: () => {},
      isParentAborted: () => false,
      sanitize: () => [] as AiMessage[],
      formatKnock: () => 'knock',
    }
  }

  it('两个伙计先后完成时，等齐两个人才返回——不能听完第一声就不听了', async () => {
    const roster = new SubAgentRoster()
    const fast = stubChild({ delayMs: 20, result: '快的做完了' })
    const slow = stubChild({ delayMs: 80, result: '慢的做完了' })
    const kids = [fast, slow]
    roster.spawn(
      [
        { name: '读包', description: '读包', prompt: '读 package.json' },
        { name: '读说明', description: '读说明', prompt: '读 README' },
      ],
      { ...spawnDeps(roster, () => kids.shift()!), maxConcurrent: 2 }
    )

    const started = Date.now()
    const done = await roster.waitUntil(['读包', '读说明'], new AbortController().signal)
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
    expect(done.map(c => c.status)).toEqual(['completed', 'completed'])
    expect(roster.hasLive()).toBe(false)
  })

  it('waitForNews 第一个人回来就返回，不等齐', async () => {
    const roster = new SubAgentRoster()
    const fast = stubChild({ delayMs: 20, result: '快的做完了' })
    const slow = stubChild({ delayMs: 80, result: '慢的做完了' })
    const kids = [fast, slow]
    roster.spawn(
      [
        { name: '读包', description: '读包', prompt: '读 package.json' },
        { name: '读说明', description: '读说明', prompt: '读 README' },
      ],
      { ...spawnDeps(roster, () => kids.shift()!), maxConcurrent: 2 }
    )

    const started = Date.now()
    const news = await roster.waitForNews(['读包', '读说明'], new AbortController().signal)
    expect(Date.now() - started).toBeLessThan(150)
    expect(news.some(c => c.status === 'completed')).toBe(true)
    expect(roster.hasLive()).toBe(true)
  })

  it('第二次等的是下一条敲门，不会因为第一个人已经做完立刻返回', async () => {
    const roster = new SubAgentRoster()
    const fast = stubChild({ delayMs: 20, result: '快的做完了' })
    const slow = stubChild({ delayMs: 90, result: '慢的做完了' })
    const kids = [fast, slow]
    roster.spawn(
      [
        { name: '读包', description: '读包', prompt: '读 package.json' },
        { name: '读说明', description: '读说明', prompt: '读 README' },
      ],
      { ...spawnDeps(roster, () => kids.shift()!), maxConcurrent: 2 }
    )

    await roster.waitForNews(['读包', '读说明'], new AbortController().signal)
    const started = Date.now()
    const second = await roster.waitForNews(['读包', '读说明'], new AbortController().signal)
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
    expect(second.every(c => c.status === 'completed')).toBe(true)
    expect(roster.hasLive()).toBe(false)
  })

  it('敲门已经在队列里时立刻返回，不重等', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild({ delayMs: 10, result: '好了' })
    roster.spawn(
      [{ name: 'alice', description: '读', prompt: '读' }],
      spawnDeps(roster, () => child)
    )
    await roster.waitUntil(['alice'], new AbortController().signal)
    const started = Date.now()
    const news = await roster.waitForNews(['alice'], new AbortController().signal)
    expect(Date.now() - started).toBeLessThan(40)
    expect(news[0]?.status).toBe('completed')
  })
})

describe('开局带多少对话', () => {
  function spawnDeps(
    createChild: () => ChildAgentHandle,
    extras?: { sanitize?: (messages: import('../../ai.service').AiMessage[]) => import('../../ai.service').AiMessage[] }
  ) {
    return {
      createChild,
      getParentMessages: () => [
        { role: 'user' as const, content: '第一轮：先读包' },
        { role: 'assistant' as const, content: '好' },
        { role: 'user' as const, content: '第二轮：回头再列 test 脚本' },
        { role: 'assistant' as const, content: '我先派人' },
      ],
      getParentContext: () => context,
      knock: () => {},
      onProgress: () => {},
      isParentAborted: () => false,
      sanitize: extras?.sanitize ?? ((messages: import('../../ai.service').AiMessage[]) => messages),
      formatKnock: () => 'knock',
    }
  }

  it('默认全带清洗后的对话', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild({ delayMs: 1, result: 'ok' })
    roster.spawn(
      [{ name: '读包', description: '读包', prompt: '只报 name' }],
      spawnDeps(() => child)
    )
    await roster.waitUntil(['读包'], new AbortController().signal)
    expect(child.seeded).toEqual([
      { role: 'user', content: '第一轮：先读包' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '第二轮：回头再列 test 脚本' },
      { role: 'assistant', content: '我先派人' },
    ])
    expect(child.messages[0]).toBe('只报 name')
  })

  it('none 时开局只有任务说明', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild({ delayMs: 1, result: 'ok' })
    roster.spawn(
      [{ name: '读包', description: '读包', prompt: '只报 name', forkTurns: { kind: 'none' } }],
      spawnDeps(() => child)
    )
    await roster.waitUntil(['读包'], new AbortController().signal)
    expect(child.seeded).toEqual([])
    expect(child.messages[0]).toBe('只报 name')
  })

  it('最近 1 轮不带更早的用户原话', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild({ delayMs: 1, result: 'ok' })
    roster.spawn(
      [{ name: '读包', description: '读包', prompt: '只报 name', forkTurns: { kind: 'last', n: 1 } }],
      spawnDeps(() => child)
    )
    await roster.waitUntil(['读包'], new AbortController().signal)
    expect(child.seeded).toEqual([
      { role: 'user', content: '第二轮：回头再列 test 脚本' },
      { role: 'assistant', content: '我先派人' },
    ])
  })
})

describe('allocateChildName', () => {
  it('从描述生成不重复的名字', () => {
    const used = new Set<string>()
    const a = allocateChildName('读 nginx 配置', used)
    used.add(a)
    const b = allocateChildName('读 nginx 配置', used)
    expect(a).toBe('读-nginx-配置')
    expect(b).toBe('读-nginx-配置-2')
  })
})
