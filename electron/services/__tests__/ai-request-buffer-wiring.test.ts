import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'

vi.mock('../ai-debug.service', () => ({
  getAiDebugService: () => new Proxy({}, { get: () => () => {} }),
}))
import type { AddressInfo } from 'net'
import { AiService, type ChatStreamOptions } from '../ai.service'
import { getModelRequestBuffer, modelRequestKey } from '../model-request-buffer'

type Reply = { status: number; headers?: Record<string, string>; body?: string }

const SSE_OK = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
  'data: [DONE]',
  '',
].join('\n\n')

const scripts = new Map<string, Reply[]>()
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
      res.writeHead(reply.status, reply.headers)
      res.end(reply.body ?? '')
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

  it('当面的请求在暂停中也直接发出', async () => {
    const { ai, key } = serviceFor('urgent-model')
    scripts.set('urgent-model', [{ status: 429, headers: { 'Retry-After': '5' } }])
    const background = run(ai, { bufferPriority: 'queued' }, 'bg')
    await sleep(300)
    expect(getModelRequestBuffer().snapshot(key)?.pausedForMs).toBeGreaterThan(0)

    const urgent = await run(ai)
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
