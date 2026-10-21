import { beforeEach, describe, expect, it, vi } from 'vitest'

// 接线测试：连接时写进日志、报给界面的文字里，连接器地址里的密钥一个字都不能有

const logged = vi.hoisted(() => ({ lines: [] as string[] }))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/sft-mcp-test'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }
}))

vi.mock('../../utils/logger', () => {
  const record = (...args: unknown[]) => {
    logged.lines.push(args.map(a => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' '))
  }
  const logger = { info: record, warn: record, error: record, debug: record }
  return { createLogger: () => logger }
})

// 底层 fetch 拒绝带账号口令的地址时，会把整条地址写进报错文字
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect(transport: { _url?: URL }): Promise<void> {
      const href = transport._url?.href ?? ''
      return Promise.reject(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${href}`))
    }
    close(): Promise<void> { return Promise.resolve() }
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    _url: URL
    constructor(url: URL) { this._url = url }
    close(): Promise<void> { return Promise.resolve() }
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    _url: URL
    constructor(url: URL) { this._url = url }
    close(): Promise<void> { return Promise.resolve() }
  }
}))

import { McpService, type McpServerConfig } from '../mcp.service'

const RAW = 'https://user:SECRET-PASS@mcp.example.com/api/SECRET-PATH/mcp?api_key=SECRET-KEY'

function config(transport: 'http' | 'sse'): McpServerConfig {
  return { id: 'x', name: '烯牛数据', enabled: true, transport, url: RAW }
}

describe('McpService.connect 不把地址里的密钥写出去', () => {
  beforeEach(() => { logged.lines.length = 0 })

  for (const transport of ['http', 'sse'] as const) {
    it(`${transport}：连接时与连接失败时的日志、界面错误提示都不含密钥`, async () => {
      const mcp = new McpService()
      const emitted: string[] = []
      mcp.on('error', (e: { error: string }) => emitted.push(e.error))

      const failure = await mcp.connect(config(transport)).catch((e: Error) => e)

      expect(failure).toBeInstanceOf(Error)
      const shown = [...logged.lines, ...emitted, (failure as Error).message, ...mcp.getServerStatuses().map(s => s.error ?? '')]
      for (const text of shown) {
        expect(text).not.toContain('SECRET')
      }
      // 不是什么都没写：日志里仍能认出是哪个地址
      expect(shown.some(s => s.includes('https://mcp.example.com'))).toBe(true)
    })
  }

  it('stdio：启动参数的内容不写日志', async () => {
    const mcp = new McpService()
    const stdio: McpServerConfig = {
      id: 'y', name: '本地连接器', enabled: true, transport: 'stdio',
      command: 'npx', args: ['-y', 'some-mcp', '--api-key', 'SECRET-ARG']
    }
    await mcp.connect(stdio).catch(() => undefined)
    for (const line of logged.lines) {
      expect(line).not.toContain('SECRET')
    }
    expect(logged.lines.some(l => l.includes('Args: 4'))).toBe(true)
  })
})
