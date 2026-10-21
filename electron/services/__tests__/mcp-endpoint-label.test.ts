import { describe, expect, it } from 'vitest'
import { describeMcpEndpointForLog, scrubMcpEndpoint } from '../mcp-endpoint-label'

describe('describeMcpEndpointForLog', () => {
  it('keeps only scheme, host and port', () => {
    expect(describeMcpEndpointForLog('https://agent.qcc.com/mcp/company/stream')).toBe('https://agent.qcc.com')
    expect(describeMcpEndpointForLog('http://127.0.0.1:8931/sse')).toBe('http://127.0.0.1:8931')
  })

  it('drops secrets wherever they sit in the address', () => {
    const inQuery = describeMcpEndpointForLog('https://vip.example.com/mcp?api_key=SECRET-IN-QUERY&x=1')
    const inPath = describeMcpEndpointForLog('https://mcp.example.com/api/s/SECRET-IN-PATH/mcp')
    const inUserinfo = describeMcpEndpointForLog('https://user:SECRET-IN-USERINFO@mcp.example.com/mcp')
    const inHash = describeMcpEndpointForLog('https://mcp.example.com/mcp#SECRET-IN-HASH')

    expect(inQuery).toBe('https://vip.example.com')
    expect(inPath).toBe('https://mcp.example.com')
    expect(inUserinfo).toBe('https://mcp.example.com')
    expect(inHash).toBe('https://mcp.example.com')
    for (const out of [inQuery, inPath, inUserinfo, inHash]) {
      expect(out).not.toContain('SECRET')
    }
  })

  it('does not echo an unparsable address back', () => {
    expect(describeMcpEndpointForLog('not a url?api_key=SECRET-RAW')).toBe('(无法解析的地址)')
  })

  it('only treats http and https as an address', () => {
    for (const raw of ['file:///tmp/SECRET-FILE', 'ftp://host/SECRET-FTP', 'ws://host:1/SECRET-WS']) {
      expect(describeMcpEndpointForLog(raw)).toBe('(非 http(s) 地址)')
    }
  })
})

describe('scrubMcpEndpoint', () => {
  const raw = 'https://user:SECRET-PASS@mcp.example.com/mcp?api_key=SECRET-KEY'

  it('replaces the address as written in the configuration', () => {
    const text = `TypeError: Request cannot be constructed from a URL that includes credentials: ${raw}`
    const out = scrubMcpEndpoint(text, raw)
    expect(out).toContain('https://mcp.example.com')
    expect(out).not.toContain('SECRET')
  })

  it('also replaces the normalised form the runtime prints', () => {
    // 没有路径时规范化会多一个结尾斜杠
    const bare = 'https://user:SECRET-PASS@mcp.example.com'
    const out = scrubMcpEndpoint(`fetch to ${new URL(bare).href} failed; configured as ${bare}`, bare)
    expect(out).not.toContain('SECRET')
  })

  it('replaces every occurrence and leaves other text alone', () => {
    const out = scrubMcpEndpoint(`a ${raw} b ${raw} c`, raw)
    expect(out).toBe('a https://mcp.example.com b https://mcp.example.com c')
    expect(scrubMcpEndpoint('connect ECONNREFUSED', raw)).toBe('connect ECONNREFUSED')
  })

  it('is a no-op without a configured address (stdio)', () => {
    expect(scrubMcpEndpoint('spawn npx ENOENT', undefined)).toBe('spawn npx ENOENT')
  })
})
