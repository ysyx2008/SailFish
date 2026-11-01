import { describe, expect, it } from 'vitest'
import { PROBE_MAX_OUTPUT_BYTES, ProbeOutputLimitError, readProbeBody } from '../../sensor/probe-output'

describe('探针响应体完整读取', () => {
  it('保留原 8192 字符边界之后的正文', async () => {
    const body = 'x'.repeat(9000) + '尾部'
    expect(await readProbeBody(new Response(body))).toBe(body)
  })
  it('按字节而非字符拒绝超限内容', async () => {
    await expect(readProbeBody(new Response('汉'.repeat(400000)))).rejects.toBeInstanceOf(ProbeOutputLimitError)
  })
  it('容量边界上的内容仍完整读取', async () => {
    const body = 'x'.repeat(PROBE_MAX_OUTPUT_BYTES)
    expect(await readProbeBody(new Response(body))).toBe(body)
  })
  it('流式超限时取消后续读取', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(65536)) },
      cancel() { cancelled = true },
    })
    await expect(readProbeBody(new Response(stream))).rejects.toThrow('未更新比较基线')
    expect(cancelled).toBe(true)
  })
  it('跨数据块的中文与 emoji 不损坏', async () => {
    const body = '汉字🐟尾部'
    const bytes = new TextEncoder().encode(body)
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close() } })
    expect(await readProbeBody(new Response(stream))).toBe(body)
  })
})
