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
import { parseExpertVerdict } from '../verdict'

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
  executionMode: 'relaxed',
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
    const user = messages[1]!.content
    expect(user).toContain('看一下 db1 的状态')
    expect(user).toContain('db1（ops@10.0.0.1:22），分组：生产')
    expect(user).toContain('uptime')
    expect(user).toContain('解析为只读')
    expect(user).toContain('systemctl restart nginx')
    expect(user).toMatch(/restart[\s\S]*不算只读|不算只读[\s\S]*restart/)
    expect(user).toContain('宽松')
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

  it('补单时说明是给哪个伙计补的', async () => {
    const chat = vi.fn(async () => ({ content: '{"outcome":"allow","card":"ok"}' }))
    await new RemoteExpert(env(chat)).judge({ ...INPUT, forWorker: 'w1', workerCount: undefined })
    const user = (chat.mock.calls[0] as unknown as [Array<{ content: string }>])[0][1]!.content
    expect(user).toContain('补几条命令')
    expect(user).toContain('w1')
  })
})
