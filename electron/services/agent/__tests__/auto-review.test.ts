import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sailfish-auto-review-test', getName: () => 'SailFish', getVersion: () => '1.0.0' },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))
import type { AgentStep } from '@shared/types'
import type { AiMessage, ChatWithToolsResult } from '../../ai.service'
import { parseAssessment, tableAllows, assessmentApproves, effectiveAssessment } from '../auto-review/verdict'
import { collectUserWords, cursorAt, cursorStillValid, formatProcess } from '../auto-review/evidence'
import { runInspection, checkReadOnlyCommand, type InspectorDeps } from '../auto-review/inspector'
import { getWorkspacePath } from '../workspace-paths'
import {
  AutoApprovalReviewer,
  USER_WORDS_BUDGET_CHARS,
  type AutoReviewChat,
  type AutoReviewRequest,
} from '../auto-review/reviewer'

function step(partial: Partial<AgentStep> & Pick<AgentStep, 'id' | 'type'>): AgentStep {
  return { content: '', timestamp: 0, ...partial } as AgentStep
}

function verdictJson(risk: string, auth: string, outcome: string, rationale = '理由'): string {
  return JSON.stringify({ risk_level: risk, user_authorization: auth, outcome, rationale })
}

function reply(content: string, extra: Partial<ChatWithToolsResult> = {}): ChatWithToolsResult {
  return { content, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cache_hit_tokens: 60 }, ...extra }
}

function makeInspector(overrides: Partial<InspectorDeps> = {}): InspectorDeps {
  return {
    checkReadOnly: async () => null,
    local: { run: async (cmd: string) => ({ output: `ran ${cmd}`, exitCode: 0, timedOut: false }) },
    ...overrides,
  }
}

function makeRequest(steps: AgentStep[], messages: AiMessage[], overrides: Partial<AutoReviewRequest> = {}): AutoReviewRequest {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    locale: 'zh-CN',
    toolName: 'exec',
    toolArgs: { command: 'rm -rf /tmp/build' },
    riskLevel: 'dangerous',
    reasons: ['递归删除'],
    getSteps: () => steps,
    getMessages: () => messages,
    aiRules: '',
    environment: { terminalType: 'local', cwd: '/tmp' },
    inspector: makeInspector(),
    ...overrides,
  }
}

describe('替我审批 · 裁决', () => {
  it('解析合法 JSON，前后有杂字也行', () => {
    const a = parseAssessment(`想了想\n${verdictJson('high', 'high', 'allow')}\n完`)
    expect(a).toMatchObject({ risk: 'high', authorization: 'high', outcome: 'allow' })
  })

  it('缺字段、枚举不对、理由为空都看不懂', () => {
    expect(parseAssessment('不是 JSON')).toBeNull()
    expect(parseAssessment(verdictJson('extreme', 'high', 'allow'))).toBeNull()
    expect(parseAssessment(verdictJson('low', 'high', 'deny'))).toBeNull()
    expect(parseAssessment(verdictJson('low', 'high', 'allow', '  '))).toBeNull()
    expect(parseAssessment(undefined)).toBeNull()
  })

  it('固定的表：致命永不，高危要实质授权，中危要看得出授权，低危不看授权', () => {
    expect(tableAllows('critical', 'high')).toBe(false)
    expect(tableAllows('high', 'high')).toBe(true)
    expect(tableAllows('high', 'medium')).toBe(true)
    expect(tableAllows('high', 'low')).toBe(false)
    expect(tableAllows('medium', 'low')).toBe(true)
    expect(tableAllows('medium', 'unknown')).toBe(false)
    expect(tableAllows('low', 'unknown')).toBe(true)
  })

  it('模型说放行但表不允许，不放行；表允许但模型说问人，也不放行', () => {
    expect(assessmentApproves({ risk: 'critical', authorization: 'high', outcome: 'allow', rationale: 'x' })).toBe(false)
    expect(assessmentApproves({ risk: 'low', authorization: 'high', outcome: 'ask_user', rationale: 'x' })).toBe(false)
    expect(assessmentApproves({ risk: 'medium', authorization: 'medium', outcome: 'allow', rationale: 'x' })).toBe(true)
  })

  it('旗鱼自己的定级是下限：模型把危险操作打成低危，仍按高危要授权', () => {
    const lowAllow = { risk: 'low' as const, authorization: 'unknown' as const, outcome: 'allow' as const, rationale: '没事' }
    expect(assessmentApproves(lowAllow)).toBe(true)
    expect(assessmentApproves(lowAllow, 'dangerous')).toBe(false)
    expect(effectiveAssessment(lowAllow, 'dangerous').risk).toBe('high')
    expect(assessmentApproves({ ...lowAllow, authorization: 'high' }, 'dangerous')).toBe(true)
  })
})

describe('替我审批 · 证据', () => {
  it('只收用户亲手说的：发起、补充、亲手回答；主动消息占位和超时默认值不算', () => {
    const steps = [
      step({ id: 'a', type: 'user_task', content: '把 /tmp/build 清掉' }),
      step({ id: 'b', type: 'user_task', content: '__proactive__' }),
      step({ id: 'c', type: 'message', content: '好的，我先看看' }),
      step({ id: 'd', type: 'asking', content: '确定删除吗？', askingStatus: 'received', askingAnswer: '确定' }),
      step({ id: 'e', type: 'asking', content: '要备份吗？', askingStatus: 'timeout' }),
      step({ id: 'f', type: 'asking', content: '空回复？', askingStatus: 'received' }),
      step({ id: 'g', type: 'user_supplement', content: '顺便把 dist 也清了' }),
    ]
    const words = collectUserWords(steps)
    expect(words.map(w => [w.id, w.kind, w.text])).toEqual([
      ['a', 'task', '把 /tmp/build 清掉'],
      ['d', 'answer', '确定'],
      ['g', 'supplement', '顺便把 dist 也清了'],
    ])
    expect(words[1].question).toBe('确定删除吗？')
  })

  it('干活那边被压缩改写后，游标失效', () => {
    const msgs: AiMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a1' },
    ]
    const cursor = cursorAt(msgs)
    expect(cursorStillValid([...msgs, { role: 'assistant', content: 'a2' }], cursor)).toBe(true)
    expect(cursorStillValid([{ role: 'user', content: 'summary' }], cursor)).toBe(false)
    expect(cursorStillValid([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'changed' }], cursor)).toBe(false)
  })

  it('过程不带用户消息，超预算保留最近的并注明省略', () => {
    const msgs: AiMessage[] = [
      { role: 'user', content: '用户消息里有文档正文' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'assistant' as const, content: `第${i}步 ${'x'.repeat(100)}` })),
    ]
    const text = formatProcess(msgs, 0, 500)
    expect(text).not.toContain('文档正文')
    expect(text).toContain('第19步')
    expect(text).not.toContain('第0步')
    expect(text).toContain('更早的过程已省略')
  })
})

describe('替我审批 · 只读核查', () => {
  const call = (name: string, args: Record<string, unknown>) => ({
    id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) },
  })

  it('本机只跑判为只读的命令', async () => {
    const run = vi.fn(async () => ({ output: 'ok', exitCode: 0, timedOut: false }))
    const deps = makeInspector({
      local: { run },
      checkReadOnly: async (cmd: string) => (cmd.startsWith('ls') ? null : '不是只读'),
    })
    expect(await runInspection(call('inspect_local', { command: 'ls /tmp' }), deps)).toContain('ok')
    expect(await runInspection(call('inspect_local', { command: 'rm -rf /tmp' }), deps)).toContain('拒绝')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('真实命令审计：安全不等于只读，写重定向、私有目录里的删改都拒绝', async () => {
    const ws = getWorkspacePath()
    for (const cmd of ['ls -la /tmp', 'cat /etc/hosts', 'du -sh /tmp', 'ls /tmp | wc -l', 'stat /tmp 2>/dev/null']) {
      expect(await checkReadOnlyCommand(cmd), cmd).toBeNull()
    }
    for (const cmd of [
      'echo hi > /tmp/a.txt',
      `echo hi >> ${ws}/a.txt`,
      `rm -rf ${ws}/scratch/a`,
      `touch ${ws}/b`,
      `mkdir ${ws}/c`,
      'tee /tmp/x',
      'sed -i s/a/b/ /tmp/x',
      'find / -name x -delete',
      'curl http://example.com',
      'mytool status',
    ]) {
      expect(await checkReadOnlyCommand(cmd), cmd).not.toBeNull()
    }
  })

  it('没有远程时说明没有，有远程时走 stat/list', async () => {
    expect(await runInspection(call('inspect_remote', { action: 'stat', path: '/etc' }), makeInspector())).toContain('没有可查的远程')
    const deps = makeInspector({
      remote: { host: 'web1', stat: async p => `${p}：目录`, list: async p => `${p}（共 0 条）` },
    })
    expect(await runInspection(call('inspect_remote', { action: 'stat', path: '/etc' }), deps)).toContain('web1')
    expect(await runInspection(call('inspect_remote', { action: 'rm', path: '/etc' }), deps)).toContain('拒绝')
  })
})

describe('替我审批 · 评审员', () => {
  const baseSteps = () => [step({ id: 'u1', type: 'user_task', content: '把 /tmp/build 删掉重建' })]
  const baseMessages = (): AiMessage[] => [
    { role: 'user', content: '把 /tmp/build 删掉重建' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'exec', arguments: '{"command":"rm -rf /tmp/build"}' } }] },
  ]

  it('两边都同意才放行，并带回用量', async () => {
    const chat = vi.fn<AutoReviewChat>(async () => reply(verdictJson('high', 'high', 'allow', '用户明确要删')))
    const reviewer = new AutoApprovalReviewer({ chat })
    const r = await reviewer.review(makeRequest(baseSteps(), baseMessages()))
    expect(r.kind).toBe('approved')
    expect(r.usage?.total_tokens).toBe(110)
    const sent = chat.mock.calls[0][0]
    expect(sent[0].role).toBe('system')
    expect(sent[1].content).toContain('把 /tmp/build 删掉重建')
    expect(sent[1].content).toContain('rm -rf /tmp/build')
  })

  it('模型说问人、看不懂、出错、超时，都交回用户', async () => {
    const cases: Array<[AutoReviewChat, string]> = [
      [async () => reply(verdictJson('high', 'low', 'ask_user')), 'not_approved'],
      [async () => reply('我觉得可以'), 'failed'],
      [async () => { throw new Error('boom') }, 'failed'],
      [() => new Promise<ChatWithToolsResult>(() => {}), 'failed'],
    ]
    for (const [chat, reason] of cases) {
      const reviewer = new AutoApprovalReviewer({ chat, timeoutMs: 30 })
      const r = await reviewer.review(makeRequest(baseSteps(), baseMessages()))
      expect(r).toMatchObject({ kind: 'handed_over', reason })
    }
  })

  it('想到一半被截断、没写出结论，交回用户并注明截断', async () => {
    const chat = vi.fn<AutoReviewChat>(async () => ({ content: undefined, finish_reason: 'length' }))
    const reviewer = new AutoApprovalReviewer({ chat })
    const r = await reviewer.review(makeRequest(baseSteps(), baseMessages()))
    expect(r).toMatchObject({ kind: 'handed_over', reason: 'failed', detail: 'truncated' })
    expect(chat.mock.calls[0][4]?.maxOutputTokens).toBeUndefined()
  })

  it('任务被停时不算没放行，直接取消', async () => {
    const ac = new AbortController()
    const reviewer = new AutoApprovalReviewer({ chat: () => new Promise<ChatWithToolsResult>(() => {}) })
    const p = reviewer.review(makeRequest(baseSteps(), baseMessages(), { signal: ac.signal }))
    ac.abort()
    expect((await p).kind).toBe('cancelled')
  })

  it('连着三次没放行，这一轮后面直接问人；新一轮重新计数', async () => {
    const chat = vi.fn<AutoReviewChat>(async () => reply(verdictJson('high', 'unknown', 'ask_user')))
    const reviewer = new AutoApprovalReviewer({ chat })
    for (let i = 0; i < 3; i++) await reviewer.review(makeRequest(baseSteps(), baseMessages()))
    const r = await reviewer.review(makeRequest(baseSteps(), baseMessages()))
    expect(r).toMatchObject({ kind: 'handed_over', reason: 'circuit_open' })
    expect(chat).toHaveBeenCalledTimes(3)
    await reviewer.review(makeRequest(baseSteps(), baseMessages(), { runId: 'run-2' }))
    expect(chat).toHaveBeenCalledTimes(4)
  })

  it('原话太长不评、不截断，直接交回', async () => {
    const chat = vi.fn<AutoReviewChat>()
    const reviewer = new AutoApprovalReviewer({ chat })
    const steps = [step({ id: 'u1', type: 'user_task', content: 'x'.repeat(USER_WORDS_BUDGET_CHARS + 1) })]
    const r = await reviewer.review(makeRequest(steps, baseMessages()))
    expect(r).toMatchObject({ kind: 'handed_over', reason: 'too_large' })
    expect(chat).not.toHaveBeenCalled()
  })

  it('同一场再评：前面逐字不变，只补新增的原话和过程；缓存断点落在上次的回答上', async () => {
    const chat = vi.fn<AutoReviewChat>(async () => reply(verdictJson('medium', 'high', 'allow')))
    const reviewer = new AutoApprovalReviewer({ chat })
    const steps = baseSteps()
    const messages = baseMessages()
    await reviewer.review(makeRequest(steps, messages))
    const first = chat.mock.calls[0][0].map(m => m.content)

    steps.push(step({ id: 'u2', type: 'user_supplement', content: '再把 /tmp/cache 也清了' }))
    messages.push({ role: 'tool', tool_call_id: 't1', content: '已删除' })
    await reviewer.review(makeRequest(steps, messages, { toolArgs: { command: 'rm -rf /tmp/cache' } }))
    const second = chat.mock.calls[1][0]

    expect(second.slice(0, first.length).map(m => m.content)).toEqual(first)
    expect(second[first.length].role).toBe('assistant')
    expect(second[first.length]._cacheBreakpoint).toBe(true)
    const delta = second[first.length + 1].content
    expect(delta).toContain('再把 /tmp/cache 也清了')
    expect(delta).not.toContain('把 /tmp/build 删掉重建')
    expect(delta).toContain('已删除')
  })

  it('换了会话或规则变了，从头来', async () => {
    const chat = vi.fn<AutoReviewChat>(async () => reply(verdictJson('medium', 'high', 'allow')))
    const reviewer = new AutoApprovalReviewer({ chat })
    await reviewer.review(makeRequest(baseSteps(), baseMessages()))
    await reviewer.review(makeRequest(baseSteps(), baseMessages(), { aiRules: '别删生产库' }))
    expect(chat.mock.calls[1][0]).toHaveLength(2)
    expect(chat.mock.calls[1][0][1].content).toContain('别删生产库')
    await reviewer.review(makeRequest(baseSteps(), baseMessages(), { aiRules: '别删生产库', sessionId: 'session-2' }))
    expect(chat.mock.calls[2][0]).toHaveLength(2)
  })

  it('评审期间用户又说话：放行作废重评；再变就交给用户', async () => {
    const steps = baseSteps()
    let n = 0
    const chat = vi.fn<AutoReviewChat>(async () => {
      n++
      steps.push(step({ id: `s${n}`, type: 'user_supplement', content: `等等${n}` }))
      return reply(verdictJson('medium', 'high', 'allow'))
    })
    const reviewer = new AutoApprovalReviewer({ chat })
    const r = await reviewer.review(makeRequest(steps, baseMessages()))
    expect(r).toMatchObject({ kind: 'handed_over', reason: 'user_spoke' })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[1][0].at(-1)?.content).toContain('等等1')
  })

  it('用户说一次话，重评一次后放行', async () => {
    const steps = baseSteps()
    let first = true
    const chat = vi.fn<AutoReviewChat>(async () => {
      if (first) {
        first = false
        steps.push(step({ id: 's1', type: 'user_supplement', content: '可以删' }))
      }
      return reply(verdictJson('medium', 'high', 'allow'))
    })
    const reviewer = new AutoApprovalReviewer({ chat })
    const r = await reviewer.review(makeRequest(steps, baseMessages()))
    expect(r.kind).toBe('approved')
    expect(r.usage?.total_tokens).toBe(220)
  })

  it('同一场并行的两次评审排队，第二次能看见第一次已经提交的记录', async () => {
    let firstStarted!: () => void
    const gate = new Promise<void>(r => { firstStarted = r })
    let n = 0
    const chat = vi.fn<AutoReviewChat>(async () => {
      n++
      if (n === 1) {
        firstStarted()
        await new Promise(r => setTimeout(r, 30))
      }
      return reply(verdictJson('medium', 'high', 'allow'))
    })
    const reviewer = new AutoApprovalReviewer({ chat })
    const req1 = makeRequest(baseSteps(), baseMessages(), { toolArgs: { command: 'rm a' } })
    const req2 = makeRequest(baseSteps(), baseMessages(), { toolArgs: { command: 'rm b' } })
    const p1 = reviewer.review(req1)
    await gate
    const p2 = reviewer.review(req2)
    await Promise.all([p1, p2])
    expect(chat.mock.calls[1][0].length).toBeGreaterThan(chat.mock.calls[0][0].length)
    expect(chat.mock.calls[1][0][1].content).toContain('rm a')
  })

  it('本地整理证据出错时交回用户，不当工具失败', async () => {
    const reviewer = new AutoApprovalReviewer({ chat: vi.fn() })
    const r = await reviewer.review(makeRequest(baseSteps(), baseMessages(), {
      getSteps: () => { throw new Error('steps boom') },
    }))
    expect(r).toMatchObject({ kind: 'handed_over', reason: 'failed' })
  })

  it('可以先核查再下结论；核查轮数到顶后禁止再调工具', async () => {
    const chat = vi.fn<AutoReviewChat>(async (_m, _t, _p, _s, opts) => {
      if (opts?.toolChoice === 'none') return reply(verdictJson('medium', 'high', 'allow'))
      return reply('', { tool_calls: [{ id: `c${chat.mock.calls.length}`, type: 'function', function: { name: 'inspect_local', arguments: '{"command":"ls /tmp/build"}' } }] })
    })
    const run = vi.fn(async () => ({ output: 'a b c', exitCode: 0, timedOut: false }))
    const reviewer = new AutoApprovalReviewer({ chat, maxInspections: 2 })
    const r = await reviewer.review(makeRequest(baseSteps(), baseMessages(), { inspector: makeInspector({ local: { run } }) }))
    expect(r.kind).toBe('approved')
    expect(run).toHaveBeenCalledTimes(2)
    expect(chat).toHaveBeenCalledTimes(3)
    const last = chat.mock.calls[2][0]
    expect(last.filter(m => m.role === 'tool').map(m => m.content)).toEqual([expect.stringContaining('a b c'), expect.stringContaining('a b c')])
  })
})
