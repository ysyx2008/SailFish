import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mockUserData = path.join(os.tmpdir(), `sft-remote-expert-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { ensureAgentWorkspaceDirs } from '../../../tools/file'
import { RemoteExpert, type ExpertInput, type RemoteExpertEnv } from '../remote-expert'
import { parseExpertVerdict, readExpertPartial, type ExpertPartial } from '../verdict'

beforeAll(() => {
  fs.mkdirSync(mockUserData, { recursive: true })
  ensureAgentWorkspaceDirs()
})

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true })
})

vi.mock('../../../../utils/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))

describe('parseExpertVerdict', () => {
  it('三种结论各自带必填的话', () => {
    expect(parseExpertVerdict('{"outcome":"allow","card":"你点名了这台，只看状态"}')).toEqual({ outcome: 'allow', note: '你点名了这台，只看状态' })
    expect(parseExpertVerdict('{"outcome":"ask_user","card":"这批会重启 3 台"}')).toEqual({ outcome: 'ask_user', card: '这批会重启 3 台' })
    expect(parseExpertVerdict('{"outcome":"refuse","reason":"会格式化磁盘"}')).toEqual({ outcome: 'refuse', reason: '会格式化磁盘' })
  })

  it('周围有多余文字也能取出 JSON', () => {
    expect(parseExpertVerdict('好的\n{"outcome":"ask_user","card":"请确认"}\n谢谢')).toEqual({ outcome: 'ask_user', card: '请确认' })
  })

  it('第一行是结论、后面是说明', () => {
    expect(parseExpertVerdict('allow\n\n你点名了这台，只看状态')).toEqual({ outcome: 'allow', note: '你点名了这台，只看状态' })
    expect(parseExpertVerdict('ask_user\n\n这批会重启 3 台')).toEqual({ outcome: 'ask_user', card: '这批会重启 3 台' })
    expect(parseExpertVerdict('refuse\n\n会格式化磁盘')).toEqual({ outcome: 'refuse', reason: '会格式化磁盘' })
  })

  it('说明里再出现别的结论，仍以第一行为准', () => {
    expect(parseExpertVerdict('allow\n\n只是看状态，不要执行 {"outcome":"refuse","reason":"别的"}')).toEqual({
      outcome: 'allow',
      note: '只是看状态，不要执行 {"outcome":"refuse","reason":"别的"}',
    })
  })

  it('结论一换行就能读，说明随后变长', () => {
    expect(readExpertPartial('all')).toBeNull()
    expect(readExpertPartial('allow')).toBeNull()
    expect(readExpertPartial('allow\n')).toEqual({ outcome: 'allow', text: '' })
    expect(readExpertPartial('allow\n\n只')).toEqual({ outcome: 'allow', text: '只' })
    expect(readExpertPartial('allow\n\n只是看状态')).toEqual({ outcome: 'allow', text: '只是看状态' })
    expect(readExpertPartial('先说一下\nallow')).toBeNull()
  })

  it.each([
    ['空', ''],
    ['不是 JSON', 'allow'],
    ['结论不在枚举里', '{"outcome":"approve","card":"x"}'],
    ['allow 没写理由', '{"outcome":"allow"}'],
    ['ask_user 没有给用户的话', '{"outcome":"ask_user","reason":"x"}'],
    ['refuse 没有原因', '{"outcome":"refuse","card":"x"}'],
    ['话是空白', '{"outcome":"allow","card":"   "}'],
    ['字段类型不对', '{"outcome":"allow","card":123}'],
  ])('看不懂的输出不当放行：%s', (_label, text) => {
    expect(parseExpertVerdict(text || undefined)).toBeNull()
  })
})

const INPUT: ExpertInput = {
  hosts: [{ name: 'db1', address: 'ops@10.0.0.1:22', group: '生产' }],
  commands: ['uptime', 'systemctl restart nginx'],
  workerCount: 1,
  approval: 'autoReview',
  attended: true,
}

function env(chat: RemoteExpertEnv['chat'], over: Partial<RemoteExpertEnv> = {}): RemoteExpertEnv {
  return {
    chat,
    locale: 'zh-CN',
    words: () => [{ id: 'w1', kind: 'task', text: '看一下 db1 的状态' }],
    ...over,
  }
}

describe('RemoteExpert.judge', () => {
  it('把用户原话、主机、命令和解析器的看法一起交给模型', async () => {
    const chat = vi.fn(async () => ({ content: '{"outcome":"ask_user","card":"会重启 nginx"}' }))
    const result = await new RemoteExpert(env(chat)).judge(INPUT)
    expect(result).toEqual({ kind: 'verdict', verdict: { outcome: 'ask_user', card: '会重启 nginx' } })
    const [messages, tools, , , options] = chat.mock.calls[0] as unknown as [Array<{ role: string; content: string }>, unknown[], unknown, unknown, { toolChoice: string }]
    expect(tools).toEqual([])
    expect(options.toolChoice).toBe('none')
    expect(messages[0]!.content).toContain('outcome')
    expect(messages[0]!.content).toContain('第一行只写')
    const user = messages[1]!.content
    expect(user).toContain('看一下 db1 的状态')
    expect(user).toContain('db1（ops@10.0.0.1:22），分组：生产')
    expect(user).toContain('uptime')
    expect(user).toContain('解析为只读')
    expect(user).toContain('systemctl restart nginx')
    expect(user).toMatch(/restart[\s\S]*不算只读|不算只读[\s\S]*restart/)
    expect(user).toContain('替我审批')
  })

  it('用量交给调用方记账', async () => {
    const onUsage = vi.fn()
    const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    await new RemoteExpert(env(async () => ({ content: '{"outcome":"allow","card":"ok"}', usage }), { onUsage })).judge(INPUT)
    expect(onUsage).toHaveBeenCalledWith(usage)
  })

  it('输出看不懂：没拿到结论', async () => {
    const result = await new RemoteExpert(env(async () => ({ content: '随便说点什么' }))).judge(INPUT)
    expect(result).toEqual({ kind: 'unavailable', detail: 'unparseable' })
  })

  it('接口报错：没拿到结论', async () => {
    const result = await new RemoteExpert(env(async () => { throw new Error('boom') })).judge(INPUT)
    expect(result).toEqual({ kind: 'unavailable', detail: 'boom' })
  })

  it('一直不回：到超时就算没拿到，不无限等', async () => {
    const result = await new RemoteExpert(env(() => new Promise(() => {}), { timeoutMs: 50 })).judge(INPUT)
    expect(result).toEqual({ kind: 'unavailable', detail: 'timeout' })
  })

  it('整场被停：取消，不当失败', async () => {
    const ac = new AbortController()
    const running = new RemoteExpert(env(() => new Promise(() => {}), { signal: ac.signal })).judge(INPUT)
    setTimeout(() => ac.abort(), 20)
    expect(await running).toEqual({ kind: 'cancelled' })
  })

  it('开评之前就已被停：不调模型', async () => {
    const chat = vi.fn()
    const ac = new AbortController()
    ac.abort()
    expect(await new RemoteExpert(env(chat, { signal: ac.signal })).judge(INPUT)).toEqual({ kind: 'cancelled' })
    expect(chat).not.toHaveBeenCalled()
  })

  it('结论一出来就交出去，说明随后补上', async () => {
    const seen: ExpertPartial[] = []
    const chat = vi.fn(async (_m: unknown, _t: unknown, _p: unknown, _s: unknown, options?: { onContent?: (delta: string) => void }) => {
      options?.onContent?.('all')
      options?.onContent?.('ow\n')
      options?.onContent?.('\n只')
      options?.onContent?.('是看状态')
      return { content: 'allow\n\n只是看状态' }
    })
    const result = await new RemoteExpert(env(chat)).judge({ ...INPUT, onPartial: (partial) => seen.push({ ...partial }) })
    expect(seen).toEqual([
      { outcome: 'allow', text: '' },
      { outcome: 'allow', text: '只' },
      { outcome: 'allow', text: '只是看状态' },
    ])
    expect(result).toEqual({ kind: 'verdict', verdict: { outcome: 'allow', note: '只是看状态' } })
  })

  it('补单时说明是给哪个伙计补的', async () => {
    const chat = vi.fn(async () => ({ content: '{"outcome":"allow","card":"ok"}' }))
    await new RemoteExpert(env(chat)).judge({ ...INPUT, forWorker: 'w1', workerCount: undefined })
    const user = (chat.mock.calls[0] as unknown as [Array<{ content: string }>])[0][1]!.content
    expect(user).toContain('补几条命令')
    expect(user).toContain('w1')
  })

  it('伙计的命令清单不一样时，把分工一起交给模型', async () => {
    const chat = vi.fn(async () => ({ content: '{"outcome":"allow","card":"ok"}' }))
    const db = { name: 'db1', address: 'ops@10.0.0.1:22' }
    const web = { name: 'web1', address: 'ops@10.0.0.2:22' }
    await new RemoteExpert(env(chat)).judge({
      ...INPUT,
      hosts: [db, web],
      commands: ['uptime', 'df -h'],
      workerCount: 2,
      assignments: [
        { workerCount: 1, hosts: [db], commands: ['uptime'] },
        { workerCount: 1, hosts: [web], commands: ['df -h'] },
      ],
    })
    const user = (chat.mock.calls[0] as unknown as [Array<{ content: string }>])[0][1]!.content
    expect(user).toContain('命令清单不一样')
    expect(user).toContain('第 1 块：1 个伙计，主机：db1')
    expect(user).toContain('第 2 块：1 个伙计，主机：web1')
  })
})
