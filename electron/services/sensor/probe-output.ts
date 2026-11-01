/** 探针在容量内保留完整内容；超限是检查失败，不能以残文更新基线。 */
export const PROBE_MAX_OUTPUT_BYTES = 1024 * 1024

export class ProbeOutputLimitError extends Error {
  readonly code = 'OUTPUT_LIMIT_EXCEEDED'
  constructor() {
    super(`探针内容超过 ${PROBE_MAX_OUTPUT_BYTES} 字节，本次检查失败，未更新比较基线。可缩小命令输出或监控接口的范围。`)
  }
}

export async function readProbeBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    let next = await reader.read()
    while (!next.done) {
      const value = next.value
      size += value.byteLength
      if (size > PROBE_MAX_OUTPUT_BYTES) {
        await reader.cancel().catch(() => {})
        throw new ProbeOutputLimitError()
      }
      chunks.push(value)
      next = await reader.read()
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    reader.releaseLock()
  }
}
