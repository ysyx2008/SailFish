import { ModelSelection } from '../model-selection'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'

vi.mock('../ai-debug.service', () => ({
  getAiDebugService: () => new Proxy({}, { get: () => () => {} }),
}))
import type { AddressInfo } from 'net'
import { AiService, type ChatStreamOptions } from '../ai.service'
import { getModelRequestBuffer, modelRequestKey } from '../model-request-buffer'

type Reply = { delayMs?: number; status: number; headers?: Record<string, string>; body?: string }

const SSE_OK = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
  'data: [DONE]',
  '',
].join('\n\n')

const scripts = new Map<string, Reply[]>()
const started = new Set<string>()
let server: http.Server
let baseUrl = ''

function okReply(): Reply {
  return { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: SSE_OK }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const model = (JSON.parse(raw) as { model: string }).model
      const reply = scripts.get(model)?.shift() ?? okReply()
      started.add(model)
      setTimeout(() => { res.writeHead(reply.status, reply.headers); res.end(reply.body ?? '') }, reply.delayMs ?? 0)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

function serviceFor(model: string) {
  const profile = { id: model, name: model, apiUrl: baseUrl, apiKey: 'test-key', model }
  const config = {
    getAiProfiles: () => [profile],
    getActiveAiProfile: () => profile.id,
    get: () => false,
  }
  const ai = new AiService(config as never)
  return { ai, key: modelRequestKey(profile) }
}

function run(ai: AiService, options: ChatStreamOptions = {}, requestId?: string) {
  return new Promise<{ done?: { aborted?: boolean; content?: string }; error?: string }>((resolve) => {
    void ai.chatWithToolsStream(
      [{ role: 'user', content: 'hi' }],
      [],
      () => {},
      () => {},
      (result) => resolve({ done: result }),
      (error) => resolve({ error }),
      undefined,
      undefined,
      requestId,
      () => {},
      undefined,
      undefined,
      options,
    )
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('AI 请求经过缓冲池', () => {
  it('正常结束：放回名额', async () => {
    const { ai, key } = serviceFor('ok-model')
    const result = await run(ai)
    expect(result.done?.content).toBe('ok')
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  })

  it('接口报错：放回名额', async () => {
    const { ai, key } = serviceFor('bad-model')
    scripts.set('bad-model', [{ status: 400, body: JSON.stringify({ error: { message: 'nope' } }) }])
    const result = await run(ai)
    expect(result.error).toBeTruthy()
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  })

  it('被限流：等重试时放掉名额，重新排队后探路成功，接口算恢复', async () => {
    const { ai, key } = serviceFor('throttled-model')
    scripts.set('throttled-model', [{ status: 429, headers: { 'Retry-After': '1' } }])
    const pending = run(ai, { bufferPriority: 'queued' })
    await sleep(300)
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, recovering: true })
    const result = await pending
    expect(result.done?.content).toBe('ok')
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0, recovering: false })
  }, 10_000)

  it('服务端错误等重试时也放掉名额，到点再排', async () => {
    const { ai, key } = serviceFor('flaky-model')
    scripts.set('flaky-model', [{ status: 503, body: JSON.stringify({ error: { message: 'busy' } }) }])
    const pending = run(ai, { bufferPriority: 'queued' })
    await sleep(300)
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0 })
    const result = await pending
    expect(result.done?.content).toBe('ok')
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  }, 15_000)

  it('排队中点停止：马上按已中止收尾，不留名额', async () => {
    const { ai, key } = serviceFor('paused-model')
    scripts.set('paused-model', [{ status: 429, headers: { 'Retry-After': '5' } }])
    const first = run(ai, { bufferPriority: 'queued' }, 'first')
    await sleep(300)

    const waits: boolean[] = []
    const second = run(ai, { bufferPriority: 'queued', onBufferWait: w => waits.push(w) }, 'second')
    await sleep(100)
    expect(getModelRequestBuffer().snapshot(key)?.queued).toBe(1)

    ai.abort('second')
    const secondResult = await second
    expect(secondResult.done?.aborted).toBe(true)
    expect(waits).toEqual([true, false])

    ai.abort('first')
    const firstResult = await first
    expect(firstResult.done?.aborted).toBe(true)
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  }, 10_000)

  it('当面的请求在暂停结束后优先发出', async () => {
    const { ai, key } = serviceFor('urgent-model')
    scripts.set('urgent-model', [{ status: 429, headers: { 'Retry-After': '5' } }])
    const background = run(ai, { bufferPriority: 'queued' }, 'bg')
    await sleep(300)
    expect(getModelRequestBuffer().snapshot(key)?.pausedForMs).toBeGreaterThan(0)

    let completed = false
    const foreground = run(ai).then(result => { completed = true; return result })
    await sleep(100)
    expect(completed).toBe(false)
    const urgent = await foreground
    expect(urgent.done?.content).toBe('ok')

    ai.abort('bg')
    await background
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  }, 10_000)

  it('当面的请求被限流后，重试等窗口空出位置再发，不硬挤', async () => {
    const { ai, key } = serviceFor('crowded-model')
    const holders = await Promise.all(
      Array.from({ length: 8 }, () => getModelRequestBuffer().acquire(key, 'queued')),
    )
    scripts.set('crowded-model', [{ status: 429, headers: { 'Retry-After': '1' } }])
    let finished = false
    const urgent = run(ai).then((r) => { finished = true; return r })
    await sleep(1_500)
    expect(finished).toBe(false)
    expect(getModelRequestBuffer().snapshot(key)?.queued).toBe(1)

    for (const p of holders.slice(0, 5)) p.release()
    const result = await urgent
    expect(result.done?.content).toBe('ok')
    for (const p of holders.slice(5)) p.release()
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  }, 10_000)
})

describe('被限流时重试几次可以调', () => {
  it('只给 1 次时，第二回被限流就报错，不按默认的 5 次', async () => {
    const { ai, key } = serviceFor('impatient-model')
    const throttled = { status: 429, headers: { 'Retry-After': '1' } }
    scripts.set('impatient-model', [throttled, throttled, okReply()])
    const result = await run(ai, { rateLimitMaxRetries: 1 })
    expect(result.error).toBeTruthy()
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  }, 10_000)

  it('多给几次时，连着被限流两回也能做完', async () => {
    const { ai } = serviceFor('patient-model')
    const throttled = { status: 429, headers: { 'Retry-After': '1' } }
    scripts.set('patient-model', [throttled, throttled, okReply()])
    const result = await run(ai, { rateLimitMaxRetries: 20 })
    expect(result.done?.content).toBe('ok')
  }, 15_000)
})


describe('团队模型选择与额度熔断', () => {
  function pair(prefix: string) {
    const profiles = ['old', 'new'].map(suffix => ({ id: `${prefix}-${suffix}`, name: suffix, apiUrl: baseUrl, apiKey: 'test-key', model: `${prefix}-${suffix}` }))
    const ai = new AiService({ getAiProfiles: () => profiles, getActiveAiProfile: () => profiles[0].id, get: () => false } as never)
    return { ai, profiles }
  }

  it('主模型队列中的成员切到新模型，不等旧名额，也不泄漏旧队列', async () => {
    const { ai, profiles } = pair('switch-queued')
    const selection = new ModelSelection()
    selection.select(profiles[0].id)
    const oldKey = modelRequestKey(profiles[0])
    const holders = await Promise.all(Array.from({ length: 8 }, () => getModelRequestBuffer().acquire(oldKey, 'queued')))
    const states: string[] = []
    const task = run(ai, { getModelSelection: () => ({ profileId: selection.profileId, signal: selection.signal }), onRequestState: state => states.push(state) })
    await sleep(30)
    expect(getModelRequestBuffer().snapshot(oldKey)?.queued).toBe(1)
    selection.select(profiles[1].id)
    expect((await task).done?.content).toBe('ok')
    expect(getModelRequestBuffer().snapshot(oldKey)?.queued).toBe(0)
    expect(getModelRequestBuffer().snapshot(modelRequestKey(profiles[1]))).toMatchObject({ inFlight: 0, queued: 0 })
    expect(states).toContain('queued')
    expect(states.at(-1)).toBe('sending')
    holders.forEach(p => p.release())
  })

  it('切模型不打断已发送的请求，下一次使用新模型', async () => {
    const { ai, profiles } = pair('switch-inflight')
    const selection = new ModelSelection()
    selection.select(profiles[0].id)
    scripts.set(profiles[0].model, [{ ...okReply(), delayMs: 120 }])
    const options = { getModelSelection: () => ({ profileId: selection.profileId, signal: selection.signal }) }
    const first = run(ai, options)
    for (let i = 0; i < 30 && !started.has(profiles[0].model); i++) await sleep(5)
    expect(started.has(profiles[0].model)).toBe(true)
    selection.select(profiles[1].id)
    expect((await first).done?.content).toBe('ok')
    expect(started.has(profiles[1].model)).toBe(false)
    expect((await run(ai, options)).done?.content).toBe('ok')
    expect(started.has(profiles[1].model)).toBe(true)
  })

  it('等待重试时切模型立即迁移，不等旧模型的退避计时', async () => {
    const { ai, profiles } = pair('switch-retry')
    const selection = new ModelSelection()
    selection.select(profiles[0].id)
    scripts.set(profiles[0].model, [{ status: 429, headers: { 'Retry-After': '60' } }])
    const first = run(ai, { getModelSelection: () => ({ profileId: selection.profileId, signal: selection.signal }) })
    for (let i = 0; i < 30 && !(getModelRequestBuffer().snapshot(modelRequestKey(profiles[0]))?.recovering); i++) await sleep(5)
    expect(getModelRequestBuffer().snapshot(modelRequestKey(profiles[0]))?.recovering).toBe(true)
    selection.select(profiles[1].id)
    expect((await first).done?.content).toBe('ok')
    expect(getModelRequestBuffer().snapshot(modelRequestKey(profiles[0]))).toMatchObject({ inFlight: 0, queued: 0 })
  })

  it('配额耗尽停止HTTP重试，后续同组请求直接返回原因', async () => {
    const { ai, key } = serviceFor('quota-model')
    const message = 'Weekly usage exhausted; reset at 2099-11-02 00:00:00 +0800'
    scripts.set('quota-model', [{ status: 429, body: JSON.stringify({ error: { code: 'insufficient_quota', message } }) }, okReply()])
    const failures: unknown[] = []
    const result = await run(ai, { onApiFailure: detail => failures.push(detail) })
    expect(result.error).toContain(message)
    expect(failures).toEqual([expect.objectContaining({ code: 'insufficient_quota', category: 'quota', statusCode: 429 })])
    expect(scripts.get('quota-model')).toHaveLength(1)
    expect((await run(ai)).error).toContain(message)
    expect(scripts.get('quota-model')).toHaveLength(1)
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  })

  it('额度耗尽切备用模型时重新获取新模型名额', async () => {
    const { profiles } = pair('quota-fallback')
    scripts.set(profiles[0].model, [{ status: 429, body: JSON.stringify({ error: { code: 'insufficient_quota', message: 'quota reached' } }) }])
    const ai = new AiService({ getAiProfiles: () => profiles, getActiveAiProfile: () => profiles[0].id, get: (key: string) => key === 'autoFailoverModel' } as never)
    expect((await run(ai)).done?.content).toBe('ok')
    expect(getModelRequestBuffer().snapshot(modelRequestKey(profiles[0]))).toMatchObject({ inFlight: 0, queued: 0 })
    expect(getModelRequestBuffer().snapshot(modelRequestKey(profiles[1]))).toMatchObject({ inFlight: 0, queued: 0 })
  })
})


describe('其他推理入口共享闸门', () => {
  it('非流式聊天按窗口等待，单次请求不重复占名额', async () => {
    const { ai, key } = serviceFor('nonstream-window')
    const holders = await Promise.all(Array.from({ length: 8 }, () => getModelRequestBuffer().acquire(key, 'queued')))
    scripts.set('nonstream-window', [{ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'json-ok' } }] }) }])
    let done = false
    const task = ai.chat([{ role: 'user', content: 'hi' }]).then(value => { done = true; return value })
    await sleep(20)
    expect(done).toBe(false)
    expect(getModelRequestBuffer().snapshot(key)?.queued).toBe(1)
    holders[0].release()
    expect(await task).toBe('json-ok')
    holders.slice(1).forEach(p => p.release())
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  })

  it('非流式额度耗尽也只请求一次，后续从共享熔断返回', async () => {
    const { ai } = serviceFor('nonstream-quota')
    scripts.set('nonstream-quota', [{ status: 429, body: JSON.stringify({ error: { code: 'insufficient_quota', message: 'weekly quota exhausted' } }) }, okReply()])
    await expect(ai.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('weekly quota exhausted')
    await expect(ai.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('weekly quota exhausted')
    expect(scripts.get('nonstream-quota')).toHaveLength(1)
  })

  it('旧流式聊天入口同样经过闸门且保持文本输出', async () => {
    const { ai, key } = serviceFor('legacy-stream')
    const holders = await Promise.all(Array.from({ length: 8 }, () => getModelRequestBuffer().acquire(key, 'queued')))
    let output = ''
    const task = new Promise<void>((resolve, reject) => { void ai.chatStream([{ role: 'user', content: 'hi' }], text => { output += text }, resolve, error => reject(Error(error))) })
    await sleep(20)
    expect(output).toBe('')
    expect(getModelRequestBuffer().snapshot(key)?.queued).toBe(1)
    holders.forEach(p => p.release())
    await task
    expect(output).toBe('ok')
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  })

  it('非流式请求在服务端退避期间可立即中止', async () => {
    const { ai, key } = serviceFor('nonstream-abort-retry')
    scripts.set('nonstream-abort-retry', [{ status: 503, body: JSON.stringify({ error: { message: 'busy' } }) }, okReply()])
    const controller = new AbortController()
    const task = ai.chatWithTools([{ role: 'user', content: 'hi' }], [], undefined, controller.signal)
    // 先挂拒绝处理，避免中止与测试断言之间出现未处理的拒绝。
    const error = task.catch(reason => reason)
    for (let i = 0; i < 30 && !started.has('nonstream-abort-retry'); i++) await sleep(5)
    await sleep(20)
    controller.abort()
    expect(await error).toBeInstanceOf(Error)
    expect(scripts.get('nonstream-abort-retry')).toHaveLength(1)
    expect(getModelRequestBuffer().snapshot(key)).toMatchObject({ inFlight: 0, queued: 0 })
  })
})
